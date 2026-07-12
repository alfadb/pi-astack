#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
const layout = jiti(path.join(root, "extensions/abrain/brain-layout.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-legacy-hook-cleanup-"));
let passed = 0;
const failures = [];

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  return repo;
}

function defaultHookPath(repo) {
  return path.join(git(repo, ["rev-parse", "--absolute-git-dir"]), "hooks", "pre-push");
}

function installExact(repo) {
  const hook = defaultHookPath(repo);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, layout.legacyAdr0039PrePushHookBytes(repo, root), { mode: 0o755 });
  return hook;
}

function cleanup(repo, options = {}) {
  return layout.cleanupLegacyAdr0039PrePushHook(repo, { repoRoot: root, ...options });
}

function auditRows(repo) {
  const file = path.join(repo, ".state/legacy-hook-cleanup.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}

console.log("smoke: one-shot exact legacy ADR0039 hook cleanup");

await check("reconstructed bytes match the sole published historical body fixture", () => {
  if (process.platform === "win32") return;
  const expected = Buffer.from([
    "#!/bin/sh",
    "# pi-astack ADR0039 pre-push hook v1",
    "command -v node >/dev/null 2>&1 || exit 0",
    "SCRIPT='/fixture/pi-astack/scripts/pre-push-adr0039-reconcile.mjs'",
    "ABRAIN_HOME='/fixture/abrain'",
    "if [ ! -f \"$SCRIPT\" ]; then",
    "  echo \"WARN - pi-astack ADR0039 pre-push hook script missing; allowing push (runtime pushAsync gate remains primary).\" >&2",
    "  exit 0",
    "fi",
    "exec node \"$SCRIPT\" --abrain \"$ABRAIN_HOME\"",
    "",
  ].join("\n"), "utf8");
  const reconstructed = layout.legacyAdr0039PrePushHookBytes("/fixture/abrain", "/fixture/pi-astack");
  assert.deepEqual(reconstructed, expected);
  assert.equal(reconstructed.length, 394);
  assert.equal(createHash("sha256").update(reconstructed).digest("hex"), "c076c8c7a2c0b5c75d25990303610f0a7c71c2b80109756bd17e787d1dba671c");
});

await check("exact published legacy bytes are unlinked and audited without hook content", () => {
  const repo = initRepo("exact");
  const hook = installExact(repo);
  const result = cleanup(repo);
  assert.equal(result.status, "removed");
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(hook), false);
  assert.equal(cleanup(repo).status, "already_completed");
  assert.equal(fs.existsSync(hook), false);
  assert.match(result.legacyBodySha256, /^[0-9a-f]{64}$/);
  const rawAudit = fs.readFileSync(path.join(repo, ".state/legacy-hook-cleanup.jsonl"), "utf8");
  assert.equal(rawAudit.includes("# pi-astack ADR0039 pre-push hook v1"), false);
  assert.equal(rawAudit.includes("pre-push-adr0039-reconcile.mjs"), false);
  assert.equal(rawAudit.includes(hook), false);
  const removedRow = auditRows(repo).at(-1);
  assert.equal(removedRow.reason, "exact_pi_owned_legacy_hook_removed");
  assert.equal(removedRow.actualBodySha256, result.legacyBodySha256);
  const expectedSize = layout.legacyAdr0039PrePushHookBytes(repo, root).length;
  assert.equal(removedRow.actualSize, expectedSize);
  assert.equal(removedRow.expectedSize, expectedSize);
  assert.match(removedRow.actualMode, /^0o[0-7]+$/);
  assert.match(removedRow.actualDev, /^\d+$/);
  assert.match(removedRow.actualIno, /^\d+$/);
  assert.equal(removedRow.openedFdFstatVerified, true);
  assert.equal(removedRow.finalPathLstatVerified, true);
});

await check("same marker with a one-byte body change is preserved", () => {
  const repo = initRepo("marker-modified");
  const hook = installExact(repo);
  const exact = fs.readFileSync(hook);
  const needle = Buffer.from("command -v node", "utf8");
  const offset = exact.indexOf(needle);
  assert.notEqual(offset, -1);
  exact[offset + needle.length - 1] ^= 1;
  fs.writeFileSync(hook, exact);
  const result = cleanup(repo);
  assert.equal(result.status, "preserved_non_exact");
  assert.deepEqual(fs.readFileSync(hook), exact);
});

await check("custom hook is preserved", () => {
  const repo = initRepo("custom");
  const hook = defaultHookPath(repo);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const custom = Buffer.from("#!/bin/sh\necho user-owned\n", "utf8");
  fs.writeFileSync(hook, custom, { mode: 0o755 });
  const result = cleanup(repo);
  assert.equal(result.status, "preserved_non_exact");
  assert.deepEqual(fs.readFileSync(hook), custom);
});

await check("symlink hook is preserved without following it", () => {
  const repo = initRepo("symlink");
  const hook = defaultHookPath(repo);
  const target = path.join(repo, "user-hook-target");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(target, layout.legacyAdr0039PrePushHookBytes(repo, root));
  fs.symlinkSync(target, hook);
  const result = cleanup(repo);
  assert.equal(result.status, "preserved_symlink");
  assert.equal(fs.lstatSync(hook).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), true);
});

await check("non-regular hook is preserved", () => {
  const repo = initRepo("non-regular");
  const hook = defaultHookPath(repo);
  fs.mkdirSync(hook, { recursive: true });
  const result = cleanup(repo);
  assert.equal(result.status, "preserved_non_regular");
  assert.equal(fs.statSync(hook).isDirectory(), true);
});

await check("missing hook is a silent no-op and later startup does not recreate it", () => {
  const repo = initRepo("missing");
  const hook = defaultHookPath(repo);
  const first = cleanup(repo);
  const second = cleanup(repo);
  assert.equal(first.status, "missing");
  assert.equal(second.status, "already_completed");
  assert.equal(fs.existsSync(hook), false);
  assert.equal(auditRows(repo).length, 1);
  assert.equal(auditRows(repo)[0].reason, "historical_default_hook_absent");
});

await check("external absolute core.hooksPath exact body is preserved", () => {
  const repo = initRepo("external-hooks-path");
  const externalDir = path.join(tmp, "external-hooks");
  const externalHook = path.join(externalDir, "pre-push");
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(externalHook, layout.legacyAdr0039PrePushHookBytes(repo, root), { mode: 0o755 });
  git(repo, ["config", "core.hooksPath", externalDir]);
  const result = cleanup(repo);
  assert.equal(result.status, "missing");
  assert.deepEqual(fs.readFileSync(externalHook), layout.legacyAdr0039PrePushHookBytes(repo, root));
});

await check("ambient GIT_DIR pointing at another repo cannot redirect cleanup", () => {
  const repo = initRepo("ambient-target");
  const other = initRepo("ambient-other");
  const otherHook = defaultHookPath(other);
  const exactForTarget = layout.legacyAdr0039PrePushHookBytes(repo, root);
  fs.writeFileSync(otherHook, exactForTarget, { mode: 0o755 });
  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other, ".git");
  try {
    const result = cleanup(repo);
    assert.equal(result.status, "missing");
    assert.deepEqual(fs.readFileSync(otherHook), exactForTarget);
  } finally {
    previousGitDir === undefined ? delete process.env.GIT_DIR : process.env.GIT_DIR = previousGitDir;
  }
});

await check("core.hooksPath configured later does not hide a default-location legacy artifact", () => {
  const repo = initRepo("hooks-path-added-later");
  const historicalHook = installExact(repo);
  const externalDir = path.join(tmp, "later-external-hooks");
  const externalHook = path.join(externalDir, "pre-push");
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(externalHook, "#!/bin/sh\necho user-owned\n", { mode: 0o755 });
  git(repo, ["config", "core.hooksPath", externalDir]);
  const result = cleanup(repo);
  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(historicalHook), false);
  assert.equal(fs.readFileSync(externalHook, "utf8"), "#!/bin/sh\necho user-owned\n");
});

await check("ordinary default-location exact legacy artifact is removed", () => {
  const repo = initRepo("default-location-exact");
  const hook = installExact(repo);
  const result = cleanup(repo);
  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(hook), false);
});

await check("symlinked git-dir hooks parent is rejected without following it", () => {
  if (process.platform === "win32") return;
  const repo = initRepo("hooks-parent-symlink");
  const hooksDir = path.dirname(defaultHookPath(repo));
  const externalDir = path.join(tmp, "hooks-parent-target");
  fs.rmSync(hooksDir, { recursive: true, force: true });
  fs.mkdirSync(externalDir, { recursive: true });
  const externalHook = path.join(externalDir, "pre-push");
  fs.writeFileSync(externalHook, layout.legacyAdr0039PrePushHookBytes(repo, root), { mode: 0o755 });
  fs.symlinkSync(externalDir, hooksDir);
  const result = cleanup(repo);
  assert.equal(result.status, "failed");
  assert.match(result.warning, /hooks parent/);
  assert.equal(fs.lstatSync(hooksDir).isSymbolicLink(), true);
  assert.equal(fs.existsSync(externalHook), true);
});

await check("replacement after fd read is detected by the final path lstat", () => {
  if (process.platform === "win32") return;
  const repo = initRepo("replace-after-read");
  const hook = installExact(repo);
  const replacement = Buffer.from("#!/bin/sh\necho replacement\n", "utf8");
  const result = cleanup(repo, {
    beforeFinalLstatForTest: () => {
      const next = `${hook}.replacement`;
      fs.writeFileSync(next, replacement, { mode: 0o755 });
      fs.renameSync(next, hook);
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(auditRows(repo).at(-1).reason, "hook_changed_before_unlink");
  assert.deepEqual(fs.readFileSync(hook), replacement);
});

await check("unreadable exact hook fails soft when POSIX permissions are enforceable", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const repo = initRepo("unreadable");
  const hook = installExact(repo);
  fs.chmodSync(hook, 0o000);
  try {
    const result = cleanup(repo);
    assert.equal(result.status, "failed");
    assert.equal(result.removed, false);
    assert.equal(fs.existsSync(hook), true);
  } finally {
    fs.chmodSync(hook, 0o600);
  }
});

await check("startup runs cleanup only after the .state gitignore guard succeeds", () => {
  const indexSource = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  const layoutCall = indexSource.indexOf("ensureBrainLayout(ABRAIN_HOME)");
  const gitignoreCall = indexSource.indexOf("ensureAbrainStateGitignored(ABRAIN_HOME)");
  const readyAssignment = indexSource.indexOf("stateGitignoreGuardReady = true", gitignoreCall);
  const readyBranch = indexSource.indexOf("if (stateGitignoreGuardReady)", readyAssignment);
  const cleanupCall = indexSource.indexOf("cleanupLegacyAdr0039PrePushHook(ABRAIN_HOME)", readyBranch);
  assert(layoutCall >= 0 && gitignoreCall > layoutCall && readyAssignment > gitignoreCall, "gitignore guard is not established after layout");
  assert(readyBranch > readyAssignment && cleanupCall > readyBranch, "cleanup is not conditional on successful gitignore guard completion");
  assert(indexSource.slice(gitignoreCall, readyBranch).includes("catch"), "gitignore guard failure no longer remains non-fatal");
  assert(indexSource.slice(cleanupCall, indexSource.indexOf("  };", cleanupCall)).includes("catch"), "cleanup failure no longer remains non-fatal");
});

await check("git-sync source remains free of hook management and no installer was reintroduced", () => {
  const syncSource = fs.readFileSync(path.join(root, "extensions/abrain/git-sync.ts"), "utf8");
  const allSource = [
    syncSource,
    fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8"),
    fs.readFileSync(path.join(root, "extensions/abrain/reconcile-gate.ts"), "utf8"),
  ].join("\n");
  assert.equal(/pre-push|hooksPath|legacy-hook-cleanup|cleanupLegacyAdr0039PrePushHook/.test(syncSource), false);
  assert.equal(allSource.includes("ensureAdr0039PrePushHook"), false);
  assert.equal(allSource.includes("ADR0039_PRE_PUSH_HOOK_MARKER"), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
