#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const gitSync = await jiti.import(path.join(repoRoot, "extensions", "abrain", "git-sync.ts"));
const writer = await jiti.import(path.join(repoRoot, "extensions", "sediment", "writer.ts"));
const curator = await jiti.import(path.join(repoRoot, "extensions", "sediment", "curator.ts"));
const sedimentSettings = await jiti.import(path.join(repoRoot, "extensions", "sediment", "settings.ts"));
const { checkAdr0039ReconcileGate, ensureAdr0039PrePushHook, ADR0039_PRE_PUSH_HOOK_MARKER, DEFAULT_RECONCILE_TIMEOUT_MS } = await jiti.import(path.join(repoRoot, "extensions", "abrain", "reconcile-gate.ts"));

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function git(cwd, args) {
  return sh("git", ["-C", cwd, ...args]);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf-8");
}

function initRepo(root) {
  ensureDir(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "smoke@example.com"]);
  git(root, ["config", "user.name", "Smoke"]);
  write(path.join(root, ".gitignore"), ".state/\n");
  write(path.join(root, "seed.md"), "seed\n");
  git(root, ["add", ".gitignore", "seed.md"]);
  git(root, ["commit", "-q", "-m", "seed"]);
}

function initRemotePair(base, name) {
  const remote = path.join(base, `${name}.git`);
  const repo = path.join(base, name);
  sh("git", ["init", "--bare", "-q", remote]);
  initRepo(repo);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  return { remote, repo };
}

function auditRows(repo) {
  const file = path.join(repo, ".state", "git-sync.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abrain-push-gate-"));
try {
  {
    const gitSyncSrc = fs.readFileSync(path.join(repoRoot, "extensions", "abrain", "git-sync.ts"), "utf-8");
    assert(gitSync.DEFAULT_PUSH_TIMEOUT_MS === 60_000, `push default timeout should be 60s, got ${gitSync.DEFAULT_PUSH_TIMEOUT_MS}`);
    assert(DEFAULT_RECONCILE_TIMEOUT_MS >= 120_000, `reconcile gate default timeout should be at least 120s, got ${DEFAULT_RECONCILE_TIMEOUT_MS}`);
    assert(gitSyncSrc.includes("const reconcile = await checkAdr0039ReconcileGate({ abrainHome: opts.abrainHome });"), "pushAsync must let reconcile gate use its own default timeout");
    assert(!/checkAdr0039ReconcileGate\(\{ abrainHome: opts\.abrainHome, timeoutMs/.test(gitSyncSrc), "pushAsync must not pass its shorter git push timeout into reconcile gate");
    assert(gitSyncSrc.includes("pushAsync({ abrainHome: opts.abrainHome }).catch"), "fetchAndFF local-ahead repair must use pushAsync's push timeout default");
  }

  {
    const { repo } = initRemotePair(tmp, "runner-timeout");
    write(path.join(repo, "l2", "views", "knowledge", "latest", "dirty.md"), "dirty l2 forces full gate\n");
    const fakeRoot = path.join(tmp, "slow-reconcile-root");
    write(path.join(fakeRoot, "scripts", "smoke-adr0039-reconcile.mjs"), "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n");
    const gate = await checkAdr0039ReconcileGate({ abrainHome: repo, repoRoot: fakeRoot, timeoutMs: 10 });
    assert(!gate.ok && gate.reason === "runner_timeout", `runner timeout should be diagnosed separately, got ${JSON.stringify(gate)}`);
  }

  {
    const { repo } = initRemotePair(tmp, "pass");
    write(path.join(repo, "ok.md"), "ok\n");
    git(repo, ["add", "ok.md"]);
    git(repo, ["commit", "-q", "-m", "ok"]);
    const gate = await checkAdr0039ReconcileGate({ abrainHome: repo, repoRoot });
    assert(gate.ok, `clean gate should pass: ${JSON.stringify(gate.details.failLines)}`);
    const pushed = await gitSync.pushAsync({ abrainHome: repo, timeoutMs: 20_000 });
    assert(pushed.result === "ok", `pushAsync should pass clean repo, got ${JSON.stringify(pushed)}`);
  }

  {
    const { repo } = initRemotePair(tmp, "block");
    write(path.join(repo, "l2", "views", "knowledge", "latest", "manual.md"), "baseline l2\n");
    git(repo, ["add", "l2/views/knowledge/latest/manual.md"]);
    git(repo, ["commit", "-q", "-m", "track l2"]);
    git(repo, ["push", "-q", "origin", "main"]);
    write(path.join(repo, "pending.md"), "pending push\n");
    git(repo, ["add", "pending.md"]);
    git(repo, ["commit", "-q", "-m", "pending"]);
    write(path.join(repo, "l2", "views", "knowledge", "latest", "manual.md"), "manual dirty l2\n");
    const gate = await gitSync.pushAsync({ abrainHome: repo, timeoutMs: 20_000 });
    assert(gate.result === "push_blocked_reconcile", `dirty L2 push must be blocked, got ${JSON.stringify(gate)}`);
    const rows = auditRows(repo);
    assert(rows.some((row) => row.result === "push_blocked_reconcile"), "audit row for push_blocked_reconcile missing");
  }

  {
    const repo = path.join(tmp, "narrow");
    const projectRoot = path.join(tmp, "project-narrow");
    initRepo(repo);
    ensureDir(projectRoot);
    write(path.join(repo, "l2", "views", "knowledge", "latest", "unrelated.md"), "do not stage me\n");
    const settings = {
      ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS,
      gitCommit: true,
      knowledgeEvidenceEventWriter: { enabled: true, mode: "event_first", legacyFallbackOnEventFailure: false, legacyMarkdownWriteOnSuccessfulEvent: false },
      knowledgeProjector: { ...sedimentSettings.DEFAULT_SEDIMENT_SETTINGS.knowledgeProjector, enabled: true, projectOnWrite: true, l2OutputRoot: "repo", projectionMode: "topo" },
    };
    const result = await writer.writeProjectEntry({
      title: "Narrow Stage Entry",
      kind: "fact",
      compiledTruth: "# Narrow Stage Entry\n\nThis entry proves writer staging stays path-exact.",
      status: "active",
      confidence: 8,
      provenance: "assistant-observed",
    }, { projectRoot, abrainHome: repo, projectId: "proj-narrow", settings, dryRun: false });
    assert(result.status === "created" && result.gitCommit, `writeProjectEntry failed: ${JSON.stringify(result)}`);
    const files = git(repo, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
    assert(files.some((f) => f.startsWith("l1/events/")), `expected L1 event in commit: ${JSON.stringify(files)}`);
    assert(files.some((f) => f.startsWith("l2/views/knowledge/latest/")), `expected L2 projection in commit: ${JSON.stringify(files)}`);
    assert(!files.includes("l2/views/knowledge/latest/unrelated.md"), `unrelated L2 file was staged: ${JSON.stringify(files)}`);
    const status = git(repo, ["status", "--porcelain", "--", "l2/views/knowledge/latest/unrelated.md"]);
    assert(status.trim().startsWith("??"), `unrelated L2 should remain untracked, got ${JSON.stringify(status)}`);
  }

  {
    const hard = curator.parseDecision('{"op":"delete","slug":"entry","mode":"hard","reason":"test"}', new Map([["entry", "project"]]));
    assert(hard.op === "delete" && hard.mode === "soft" && hard.hardDeleteDowngraded === true, `hard delete should downgrade to soft with audit marker: ${JSON.stringify(hard)}`);
  }

  {
    const repo = path.join(tmp, "hook");
    initRepo(repo);
    const first = ensureAdr0039PrePushHook(repo, { repoRoot });
    assert(first.ok && (first.status === "installed" || first.status === "updated"), `hook install failed: ${JSON.stringify(first)}`);
    const second = ensureAdr0039PrePushHook(repo, { repoRoot });
    assert(second.ok && second.status === "already_installed", `hook install not idempotent: ${JSON.stringify(second)}`);
    const hookPath = path.join(repo, ".git", "hooks", "pre-push");
    const hook = fs.readFileSync(hookPath, "utf-8");
    assert(hook.includes(ADR0039_PRE_PUSH_HOOK_MARKER), "installed hook marker missing");
    assert(hook.includes("command -v node >/dev/null 2>&1 || exit 0"), "installed hook node fail-open guard missing");

    const existingRepo = path.join(tmp, "hook-existing");
    initRepo(existingRepo);
    const existingHook = path.join(existingRepo, ".git", "hooks", "pre-push");
    write(existingHook, "#!/bin/sh\necho custom\n");
    fs.chmodSync(existingHook, 0o755);
    const preserved = ensureAdr0039PrePushHook(existingRepo, { repoRoot });
    assert(!preserved.ok && preserved.status === "skipped_existing_hook", `existing hook should be preserved: ${JSON.stringify(preserved)}`);
    assert(fs.readFileSync(existingHook, "utf-8") === "#!/bin/sh\necho custom\n", "existing hook was overwritten");
  }

  console.log("PASS — abrain push integrity gate smoke passed.");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
