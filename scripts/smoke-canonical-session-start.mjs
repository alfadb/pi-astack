#!/usr/bin/env node
/** Real extension session_start integration smoke for canonical cold startup. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-canonical-session-start-"));
const abrainHome = path.join(tmp, "abrain");
const settingsPath = path.join(tmp, "settings.json");

function assert(value, message) {
  if (!value) throw new Error(message);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  }).trim();
}

function commit(repo, message, ...paths) {
  git(repo, "add", "--", ...paths);
  execFileSync("git", ["-C", repo, "commit", "-qm", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

function initRepo(repo, withIgnore = true) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  if (withIgnore) fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\nl2/views/knowledge/latest/manifest.json\n");
  commit(repo, "base", "base.txt", ...(withIgnore ? [".gitignore"] : []));
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    api: {
      on(name, handler) {
        const rows = handlers.get(name) ?? [];
        rows.push(handler);
        handlers.set(name, rows);
      },
      registerTool() {},
      registerCommand() {},
      registerEntryRenderer() {},
      getActiveTools() { return []; },
      getAllTools() { return []; },
      setActiveTools() {},
    },
  };
}

async function fire(handlers, name, event, ctx) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

try {
  initRepo(abrainHome, false);
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
  }, null, 2)}\n`);
  process.env.ABRAIN_ROOT = abrainHome;
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  process.env.PI_ABRAIN_NO_AUTOSYNC = "1";
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const canonical = await jiti.import(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  const abrainModule = await jiti.import(path.join(root, "extensions/abrain/index.ts"));
  const sedimentModule = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
  const vaultBash = await jiti.import(path.join(root, "extensions/abrain/vault-bash.ts"));
  const writer = await jiti.import(path.join(root, "extensions/sediment/writer.ts"));
  const runtimePaths = await jiti.import(path.join(root, "extensions/_shared/runtime.ts"));

  assert(canonical.canonicalStartupRunsInBackground("tui"), "TUI startup policy is blocking");
  assert(canonical.canonicalStartupRunsInBackground("rpc"), "RPC startup policy is blocking");
  assert(!canonical.canonicalStartupRunsInBackground("json"), "JSON startup policy became detached");
  assert(!canonical.canonicalStartupRunsInBackground("print"), "print startup policy became detached");

  const abrainPi = fakePi();
  const sedimentPi = fakePi();
  const activateAbrain = abrainModule.default ?? abrainModule;
  const activateSediment = sedimentModule.default ?? sedimentModule;
  activateAbrain(abrainPi.api);
  activateSediment(sedimentPi.api);

  const safety = abrainModule.getAbrainLocalSafetyStatus(abrainHome);
  assert(safety.status === "ready", `local safety not ready: ${safety.blockedReason}`);
  const gitignore = fs.readFileSync(path.join(abrainHome, ".gitignore"), "utf8");
  assert(/(^|\n)\.state\/?(\n|$)/.test(gitignore), ".state/ ignore missing after activate");
  assert(fs.existsSync(path.join(abrainHome, "vault")), "brain layout was not established synchronously");

  const envWriter = vaultBash.buildBootVaultBashDeps({
    abrainHome,
    stateDir: path.join(abrainHome, ".state"),
    activeProjectId: null,
  }).writeEnvFile;
  const envFile = envWriter([{ varName: "VAULT_SMOKE", value: "plaintext-smoke" }]);
  assert(fs.readFileSync(envFile, "utf8").includes("plaintext-smoke"), "guarded vault temp was not written");
  fs.rmSync(envFile, { force: true });

  const unsafeHome = path.join(tmp, "unsafe-abrain");
  fs.mkdirSync(unsafeHome);
  const unsafeState = path.join(unsafeHome, ".state");
  let unsafeBlocked = false;
  try {
    vaultBash.buildBootVaultBashDeps({ abrainHome: unsafeHome, stateDir: unsafeState, activeProjectId: null })
      .writeEnvFile([{ varName: "VAULT_SMOKE", value: "must-not-land" }]);
  } catch (error) {
    unsafeBlocked = /vault temp write blocked/.test(String(error));
  }
  assert(unsafeBlocked, "vault plaintext write was not blocked before gitignore");
  assert(!fs.existsSync(unsafeState), "blocked vault plaintext path created .state");

  const symlinkHome = path.join(tmp, "symlink-abrain");
  fs.mkdirSync(symlinkHome);
  const foreignIgnore = path.join(tmp, "foreign-gitignore");
  fs.writeFileSync(foreignIgnore, ".state/\nl2/views/knowledge/latest/manifest.json\n");
  fs.symlinkSync(foreignIgnore, path.join(symlinkHome, ".gitignore"));
  const symlinkSafety = abrainModule.establishAbrainLocalSafetyPrerequisites(symlinkHome);
  assert(symlinkSafety.status === "blocked", "symlink .gitignore was accepted as local safety");
  let symlinkWriteBlocked = false;
  try {
    vaultBash.buildBootVaultBashDeps({ abrainHome: symlinkHome, stateDir: path.join(symlinkHome, ".state"), activeProjectId: null })
      .writeEnvFile([{ varName: "VAULT_SMOKE", value: "must-not-land" }]);
  } catch { symlinkWriteBlocked = true; }
  assert(symlinkWriteBlocked && !fs.existsSync(path.join(symlinkHome, ".state")), "symlink gitignore allowed a vault plaintext temp");

  commit(abrainHome, "safety guard", ".gitignore");
  assert(git(abrainHome, "status", "--porcelain=v1", "-uall") === "", "fixture repo is dirty before startup");

  const notifications = [];
  const statusRows = [];
  const sessionManager = {
    getSessionId: () => "canonical-session-start-smoke",
    getSessionFile: () => path.join(tmp, "session.jsonl"),
    getBranch: () => [],
    getEntries: () => [],
  };
  const ctx = {
    mode: "tui",
    cwd: root,
    sessionManager,
    modelRegistry: undefined,
    ui: {
      notify(message, type) { notifications.push({ message, type }); },
      setStatus(key, value) { statusRows.push({ key, value }); },
    },
  };

  const tuiStarted = performance.now();
  await fire(abrainPi.handlers, "session_start", { reason: "startup" }, ctx);
  await fire(sedimentPi.handlers, "session_start", { reason: "startup" }, ctx);
  const tuiHandlerMs = performance.now() - tuiStarted;
  assert(tuiHandlerMs < 250, `real TUI session_start handlers blocked for ${tuiHandlerMs.toFixed(1)}ms`);

  const runtimeOptions = { abrainHome };
  const sharedA = canonical.getCanonicalStartupPromise(runtimeOptions);
  const sharedB = canonical.getCanonicalStartupPromise(runtimeOptions);
  assert(sharedA === sharedB, "abrain and sediment did not share one startup promise");

  const stagingPath = runtimePaths.abrainSedimentStagingPath(abrainHome);
  assert(!fs.existsSync(stagingPath), "sediment staging initialized before canonical barrier");

  const workflowPath = path.join(abrainHome, "workflows", "canonical-session-start-writer.md");
  let writerSettled = false;
  const writerPromise = writer.writeAbrainWorkflow({
    title: "Canonical Session Start Writer",
    trigger: "canonical session start smoke",
    body: "Writer must wait for the shared startup barrier before touching this file.",
    crossProject: true,
    sessionId: "canonical-session-start-smoke",
  }, {
    abrainHome,
    settings: { gitCommit: true, lockTimeoutMs: 5000 },
  }).then((result) => { writerSettled = true; return result; });
  await Promise.resolve();
  assert(!writerSettled && !fs.existsSync(workflowPath), "writer crossed the startup barrier early");

  let printReady = false;
  let printSettled = false;
  const printWait = canonical.scheduleCanonicalStartupConsumer({
    runtime: runtimeOptions,
    consumerId: "noninteractive-proof",
    mode: "print",
    onReady: () => { printReady = true; },
  }).then(() => { printSettled = true; });
  await Promise.resolve();
  assert(!printSettled, "print mode did not await canonical startup");

  const diagnostics = await sharedA;
  assert(diagnostics.startup === "ready", `real canonical startup blocked: ${diagnostics.blockedReason}`);
  assert(diagnostics.tail.some((row) => row.operation === "startup" && row.status === "local_ready"), "full Path A local_ready proof missing");
  await printWait;
  assert(printReady, "print post-barrier continuation did not run");
  const stagingDeadline = Date.now() + 1_000;
  while (!fs.existsSync(stagingPath) && Date.now() < stagingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(fs.existsSync(stagingPath), "sediment post-barrier initialization did not run");

  const writeResult = await writerPromise;
  assert(fs.existsSync(workflowPath), `writer did not run after barrier: ${JSON.stringify(writeResult)}`);
  assert(writeResult.status === "created", `writer result was not created: ${JSON.stringify(writeResult)}`);

  const blockedRepo = path.join(tmp, "blocked");
  initRepo(blockedRepo, true);
  fs.writeFileSync(path.join(blockedRepo, ".git", "index.lock"), "held\n");
  let deferred;
  let scheduleCount = 0;
  let staleNotices = 0;
  const freshNotices = [];
  const first = canonical.scheduleCanonicalStartupConsumer({
    runtime: { abrainHome: blockedRepo },
    consumerId: "repeat-session",
    mode: "tui",
    reporter: () => { staleNotices += 1; },
    onReady: () => { throw new Error("blocked runtime unexpectedly ready"); },
    schedule(task) { scheduleCount += 1; deferred = task; },
  });
  const second = canonical.scheduleCanonicalStartupConsumer({
    runtime: { abrainHome: blockedRepo },
    consumerId: "repeat-session",
    mode: "tui",
    reporter: (message, type) => { freshNotices.push({ message, type }); },
    onReady: () => { throw new Error("blocked runtime unexpectedly ready"); },
    schedule() { scheduleCount += 1; },
  });
  await Promise.all([first, second]);
  assert(scheduleCount === 1 && typeof deferred === "function", "repeated session_start was scheduled more than once");
  deferred();
  const blocked = await canonical.getCanonicalStartupPromise({ abrainHome: blockedRepo });
  assert(blocked.startup === "blocked" && /INDEX_LOCK_PRESENT/.test(blocked.blockedReason ?? ""), "blocked startup path did not remain fail-closed");
  await new Promise((resolve) => setImmediate(resolve));
  assert(staleNotices === 0, "stale session reporter was used");
  assert(freshNotices.some((row) => row.type === "warning" && row.message.includes("canonical startup blocked")), "latest session did not receive blocked warning");

  const missingRepo = path.join(tmp, "missing-repo");
  const errors = [];
  let errorReady = false;
  await canonical.scheduleCanonicalStartupConsumer({
    runtime: { abrainHome: missingRepo },
    consumerId: "startup-error",
    mode: "json",
    reporter: (message, type) => { errors.push({ message, type }); },
    onReady: () => { errorReady = true; },
  });
  assert(!errorReady && errors.some((row) => row.type === "error"), "startup rejection was not contained and reported");

  // A rejected cache entry must not poison this runtime key permanently.
  // Repair the exact missing path and retry without replacing this process.
  initRepo(missingRepo, true);
  const repaired = await canonical.getCanonicalStartupPromise({ abrainHome: missingRepo });
  assert(repaired.startup === "ready", `same-process repaired startup did not retry: ${repaired.blockedReason}`);
  assert(repaired.tail.some((row) => row.operation === "startup" && row.status === "local_ready"), "repaired startup skipped full local proof");

  let fallbackReady = false;
  const schedulerErrors = [];
  await canonical.scheduleCanonicalStartupConsumer({
    runtime: runtimeOptions,
    consumerId: "scheduler-error",
    mode: "rpc",
    reporter: (message, type) => { schedulerErrors.push({ message, type }); },
    onReady: () => { fallbackReady = true; },
    schedule() { throw new Error("scheduler-smoke"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert(fallbackReady, "scheduler failure did not fall back to microtask startup");
  assert(schedulerErrors.some((row) => row.type === "error" && row.message.includes("scheduler-smoke")), "scheduler error was not reported");

  console.log("canonical session_start integration: ok");
  console.log(`  tui_handler_ms=${tuiHandlerMs.toFixed(1)}`);
  console.log(`  shared_startup=${diagnostics.startup} tail=${diagnostics.tail.length}`);
  console.log(`  writer=${writeResult.status} staging_after_barrier=${fs.existsSync(stagingPath)}`);
  console.log(`  notifications=${notifications.length} statuses=${statusRows.length}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
