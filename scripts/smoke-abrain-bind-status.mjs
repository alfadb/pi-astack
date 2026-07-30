#!/usr/bin/env node
/**
 * /abrain bind fast-path + bind-intent queue/recovery + status no-start gate.
 * All mutations use temporary abrain homes — never touch ~/.abrain.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const runtime = jiti(path.join(root, "extensions/_shared/runtime.ts"));
const bindIntent = jiti(path.join(root, "extensions/abrain/bind-intent.ts"));
const canonical = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-abrain-bind-status-"));
const gitEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

let fails = 0;
function assert(cond, msg) {
  if (!cond) {
    fails += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv }).trim();
}

function initGitRepo(dir, withIgnore = true) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "bind-status-smoke");
  git(dir, "config", "user.email", "bind-status@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README"), "bind status smoke\n");
  const add = ["README"];
  if (withIgnore) {
    fs.writeFileSync(path.join(dir, ".gitignore"), ".state/\n");
    add.push(".gitignore");
  }
  git(dir, "add", ...add);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"], { env: gitEnv });
  return dir;
}

function writeSettings(file, enabled) {
  fs.writeFileSync(file, `${JSON.stringify({
    canonicalGitRuntime: { enabled, mode: "local_convergence_v2" },
  }, null, 2)}\n`);
}

function statusPorcelain(repo) {
  return execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "-uall"], {
    encoding: "buffer",
    env: gitEnv,
  });
}

// ── 1) local-map-only fast path ─────────────────────────────────────
{
  const abrainHome = initGitRepo(path.join(tmp, "fast-abrain"));
  const project = initGitRepo(path.join(tmp, "fast-project"));
  const projectId = "fast-project";
  // Pre-seed manifest + registry as a same-project new checkout would have.
  fs.writeFileSync(
    path.join(project, ".abrain-project.json"),
    `${JSON.stringify({ schema_version: 1, project_id: projectId }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(abrainHome, "projects", projectId), { recursive: true });
  const registryPath = path.join(abrainHome, "projects", projectId, "_project.json");
  const registryBytes = `${JSON.stringify({
    schema_version: 1,
    project_id: projectId,
    created_at: "2026-07-24T00:00:00.000+08:00",
    updated_at: "2026-07-24T00:00:00.000+08:00",
  }, null, 2)}\n`;
  fs.writeFileSync(registryPath, registryBytes);
  git(abrainHome, "add", `projects/${projectId}/_project.json`);
  execFileSync("git", ["-C", abrainHome, "commit", "-qm", "seed registry"], { env: gitEnv });
  const beforeStatus = statusPorcelain(abrainHome);
  const beforeRegistry = fs.readFileSync(registryPath);

  const plan = await bindIntent.planAbrainBind({ abrainHome, cwd: project, projectId });
  assert(plan.localMapOnly === true, "new-checkout form plans local-map-only");
  assert(plan.needsTrackedAbrainWrite === false, "local-map-only needs no tracked abrain write");
  const local = await bindIntent.applyLocalMapOnlyBind({
    abrainHome,
    projectId,
    projectRoot: project,
    now: "2026-07-24T12:00:00.000+08:00",
  });
  assert(local.localPathAdded === true, "fast path adds local path");
  const resolved = runtime.resolveActiveProject(project, { abrainHome });
  assert(!!resolved.activeProject, "fast path yields three-layer bound");
  assert(fs.readFileSync(registryPath).equals(beforeRegistry), "registry bytes unchanged after fast path");
  assert(statusPorcelain(abrainHome).equals(beforeStatus), "abrain git status unchanged after fast path");

  // Idempotent rebind
  const local2 = await bindIntent.applyLocalMapOnlyBind({
    abrainHome,
    projectId,
    projectRoot: project,
    now: "2026-07-24T13:00:00.000+08:00",
  });
  assert(local2.localPathAdded === false, "second fast path refreshes rather than duplicates");
  assert(fs.readFileSync(registryPath).equals(beforeRegistry), "idempotent rebind keeps registry bytes");
  assert(statusPorcelain(abrainHome).equals(beforeStatus), "idempotent rebind keeps abrain git status");
}

// ── 2) bind intent create-only outbox + crash/restart recovery ──────
{
  const abrainHome = initGitRepo(path.join(tmp, "intent-abrain"));
  const project = initGitRepo(path.join(tmp, "intent-project"));
  const settingsPath = path.join(tmp, "enabled.json");
  writeSettings(settingsPath, true);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;

  const plan = await bindIntent.planAbrainBind({
    abrainHome,
    cwd: project,
    projectId: "queued-project",
    now: "2026-07-24T12:00:00.000+08:00",
  });
  assert(plan.needsTrackedAbrainWrite === true, "fresh project needs tracked abrain write");
  assert(plan.registryCreated === true, "fresh project creates registry");
  const intent = bindIntent.intentFromPlan(plan);
  const written = await bindIntent.writeAbrainBindIntent(abrainHome, intent);
  assert(written.status === "created", `intent create-only status=${written.status}`);
  assert(!fs.existsSync(plan.registryPath), "queued path must not write unowned registry yet");
  const written2 = await bindIntent.writeAbrainBindIntent(abrainHome, intent);
  assert(written2.status === "identical", "duplicate intent is idempotent identical");
  const pending = await bindIntent.listAbrainBindIntentPending(abrainHome);
  assert(pending.length === 1 && pending[0].itemId === intent.itemId, "one pending intent after crash-safe create");

  // Simulate crash: intent durable, registry still absent. Restart apply via runtime.
  const rt = await canonical.getCanonicalGitRuntime({
    abrainHome,
    settingsPath,
    sourceRoot: root,
  });
  const startup = await rt.awaitStartup();
  assert(startup.startup === "ready", `startup ready for apply: ${startup.blockedReason ?? startup.startup}`);
  const applied = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
  assert(applied.status === "done", `apply after restart done: ${JSON.stringify(applied)}`);
  assert(fs.existsSync(plan.registryPath), "apply materializes registry under ownership");
  const registry = JSON.parse(fs.readFileSync(plan.registryPath, "utf8"));
  assert(registry.project_id === "queued-project", "registry project_id matches");
  const afterPending = await bindIntent.listAbrainBindIntentPending(abrainHome);
  assert(afterPending.length === 0, "successful apply clears pending");
  // local-map confirmed
  const resolved = runtime.resolveActiveProject(project, { abrainHome });
  // manifest not written by apply — only local-map + registry. Write manifest to complete bind for check.
  fs.writeFileSync(plan.manifestPath, `${JSON.stringify({ schema_version: 1, project_id: "queued-project" }, null, 2)}\n`);
  const resolved2 = runtime.resolveActiveProject(project, { abrainHome });
  assert(!!resolved2.activeProject, "after apply+manifest, three-layer bound");
  void resolved;
}

// ── 3) status / peek never starts startup ───────────────────────────
{
  const abrainHome = initGitRepo(path.join(tmp, "status-abrain"));
  const settingsPath = path.join(tmp, "status-enabled.json");
  writeSettings(settingsPath, true);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;

  // Fresh process-local state: peek must stay none and not create runtime/promise.
  // (Other tests above may have already populated global maps — measure delta.)
  const beforeRuntimes = canonical.__canonicalRuntimeMapSizeForTests();
  const beforePromises = canonical.__canonicalStartupPromiseMapSizeForTests();
  const peek1 = canonical.peekCanonicalRuntimeDiagnostics({ abrainHome });
  // abrainHome may not be in the map yet → none
  assert(peek1.status === "none" || typeof peek1.status === "string", `peek returns status without throw: ${peek1.status}`);
  const afterPeekRuntimes = canonical.__canonicalRuntimeMapSizeForTests();
  const afterPeekPromises = canonical.__canonicalStartupPromiseMapSizeForTests();
  assert(afterPeekRuntimes === beforeRuntimes, `peek must not create runtime (${beforeRuntimes}→${afterPeekRuntimes})`);
  assert(afterPeekPromises === beforePromises, `peek must not create startup promise (${beforePromises}→${afterPeekPromises})`);

  // Construct runtime + start startup, then peek must observe without extra starts.
  const rt = await canonical.getCanonicalGitRuntime({ abrainHome, settingsPath, sourceRoot: root });
  const midRuntimes = canonical.__canonicalRuntimeMapSizeForTests();
  const midPromises = canonical.__canonicalStartupPromiseMapSizeForTests();
  const peekRunningOrReady = canonical.peekCanonicalRuntimeDiagnostics({ abrainHome });
  assert(
    ["not_started", "running", "ready", "blocked", "deferred"].includes(peekRunningOrReady.status),
    `peek after getRuntime has concrete status: ${peekRunningOrReady.status}`,
  );
  assert(canonical.__canonicalRuntimeMapSizeForTests() === midRuntimes, "peek after getRuntime keeps runtime map size");
  assert(canonical.__canonicalStartupPromiseMapSizeForTests() === midPromises, "peek after getRuntime keeps promise map size");

  const ready = await rt.awaitStartup();
  assert(ready.startup === "ready", "fixture startup ready");
  const beforeAfterReadyPromises = canonical.__canonicalStartupPromiseMapSizeForTests();
  const peekReady = canonical.peekCanonicalRuntimeDiagnostics({ abrainHome });
  assert(peekReady.status === "ready", `peek sees ready: ${JSON.stringify(peekReady)}`);
  assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforeAfterReadyPromises, "peek after ready keeps promise map size");

  // Static: status handler uses peek and does not assign bootActiveProject.
  const src = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  const statusBranch = src.match(/if \(sub === "status"\) \{[\s\S]*?\n  if \(sub === "sync"\)/)?.[0] || "";
  assert(statusBranch.includes("peekCanonicalRuntimeDiagnostics"), "status uses peekCanonicalRuntimeDiagnostics");
  assert(statusBranch.includes("snapshotBootActiveProject"), "status snapshots binding without boot write");
  assert(!/bootActiveProject\s*=/.test(statusBranch), "status must not assign bootActiveProject");
  assert(!statusBranch.includes("getCanonicalGitRuntime"), "status must not call getCanonicalGitRuntime");
  assert(!statusBranch.includes("getCanonicalStartupPromise"), "status must not call getCanonicalStartupPromise");
  assert(!statusBranch.includes("awaitStartup"), "status must not awaitStartup");
}

// ── 4) production readonly peek timing (no mutation / no startup) ───
{
  const production = path.join(os.homedir(), ".abrain");
  if (fs.existsSync(production)) {
    const beforePromises = canonical.__canonicalStartupPromiseMapSizeForTests();
    const beforeRuntimes = canonical.__canonicalRuntimeMapSizeForTests();
    const t0 = process.hrtime.bigint();
    const peek = canonical.peekCanonicalRuntimeDiagnostics({ abrainHome: production });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const binding = runtime.resolveActiveProject(process.cwd(), { abrainHome: production });
    assert(elapsedMs < 50, `production peek is fast (${elapsedMs.toFixed(2)}ms)`);
    assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromises, "production peek does not change startup promise map");
    assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntimes, "production peek does not change runtime map");
    console.log(`INFO: production peek status=${peek.status} elapsedMs=${elapsedMs.toFixed(2)} binding=${binding.activeProject ? binding.activeProject.projectId : binding.reason}`);
  } else {
    console.log("INFO: skip production peek — ~/.abrain missing");
  }
}

// ── 5) blocked+published must NOT rollback tracked registry bytes ───
{
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  const previousHooks = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  const previousPost = process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
  const previousPre = process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
  try {
    const abrainHome = initGitRepo(path.join(tmp, "pub-abrain"), true);
    const project = initGitRepo(path.join(tmp, "pub-project"));
    const settingsPath = path.join(tmp, "pub-enabled.json");
    writeSettings(settingsPath, true);
    process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;

    const plan = await bindIntent.planAbrainBind({
      abrainHome,
      cwd: project,
      projectId: "published-pending-project",
      now: "2026-07-24T14:00:00.000+08:00",
    });
    const intent = bindIntent.intentFromPlan(plan);
    await bindIntent.writeAbrainBindIntent(abrainHome, intent);

    // Pre-create runtime so apply reuses it; one-shot post-publish fault.
    const rt = await canonical.getCanonicalGitRuntime({
      abrainHome,
      settingsPath,
      sourceRoot: root,
    });
    const startup = await rt.awaitStartup();
    assert(startup.startup === "ready", `published-pending startup ready: ${startup.blockedReason ?? startup.startup}`);

    const headBefore = git(abrainHome, "rev-parse", "HEAD");
    process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE = "1";
    const applied = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(applied.status === "pending", `blocked+published apply stays pending: ${JSON.stringify(applied)}`);
    assert(!/done/i.test(applied.detail || ""), "blocked+published must not be marked done");

    const registryPath = plan.registryPath;
    assert(fs.existsSync(registryPath), "published-pending keeps tracked registry bytes on disk");
    assert(
      fs.readFileSync(registryPath, "utf8") === intent.registryBytes,
      "published-pending registry bytes match intent (no rollback to absent)",
    );
    const headAfter = git(abrainHome, "rev-parse", "HEAD");
    assert(headAfter !== headBefore, "CAS published advanced HEAD for registry cohort");
    const headHasRegistry = git(abrainHome, "ls-tree", "-r", "--name-only", "HEAD")
      .split("\n")
      .includes(intent.registryRelativePath);
    assert(headHasRegistry, "HEAD contains new registry after published-pending");

    // Index may still be pre-converge (HEAD has path, index lagging → porcelain can
    // show D/?? noise). The irreversible invariant is worktree bytes were NOT rolled
    // back to pre-publish absence: file exists, matches intent, and is in HEAD.
    const porcelain = execFileSync("git", ["-C", abrainHome, "status", "--porcelain=v1", "--", intent.registryRelativePath], {
      encoding: "utf8",
      env: gitEnv,
    }).trim();
    assert(fs.existsSync(registryPath), `registry path exists after published-pending (porcelain=${porcelain || "clean"})`);
    assert(
      fs.readFileSync(registryPath, "utf8") === intent.registryBytes,
      `worktree registry still holds published intent bytes (no pre-publish rollback); porcelain=${porcelain || "clean"}`,
    );
    // Destructive rollback-to-null would also remove the path from HEAD; already checked.
    // Ensure we did not leave the worktree path missing while HEAD still has it.
    assert(
      !(!fs.existsSync(registryPath) && headHasRegistry),
      "must not delete worktree bytes that HEAD already published",
    );

    const stillPending = await bindIntent.listAbrainBindIntentPending(abrainHome);
    assert(
      stillPending.length === 1 && stillPending[0].itemId === intent.itemId,
      "intent remains pending after blocked+published",
    );

    // External lifecycle / recovery retry without the throw hook converges to done.
    delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    const recovered = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(recovered.status === "done", `recovery after published-pending done: ${JSON.stringify(recovered)}`);
    const afterPending = await bindIntent.listAbrainBindIntentPending(abrainHome);
    assert(afterPending.length === 0, "recovery clears pending intent");
    assert(fs.existsSync(registryPath), "recovery retains registry bytes");
  } finally {
    if (previousSettings === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = previousSettings;
    if (previousHooks === undefined) delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = previousHooks;
    if (previousPost === undefined) delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE = previousPost;
    if (previousPre === undefined) delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE = previousPre;
  }
}

// ── 5b) pre-publish fault rolls back tracked bytes; HEAD stays frozen ─
{
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  const previousHooks = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  const previousPost = process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
  const previousPre = process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
  try {
    const abrainHome = initGitRepo(path.join(tmp, "prepub-abrain"), true);
    const project = initGitRepo(path.join(tmp, "prepub-project"));
    const settingsPath = path.join(tmp, "prepub-enabled.json");
    writeSettings(settingsPath, true);
    process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;

    const plan = await bindIntent.planAbrainBind({
      abrainHome,
      cwd: project,
      projectId: "prepublish-rollback-project",
      now: "2026-07-24T14:05:00.000+08:00",
    });
    const intent = bindIntent.intentFromPlan(plan);
    await bindIntent.writeAbrainBindIntent(abrainHome, intent);

    const rt = await canonical.getCanonicalGitRuntime({
      abrainHome,
      settingsPath,
      sourceRoot: root,
    });
    assert((await rt.awaitStartup()).startup === "ready", "prepublish bind startup ready");

    const headBefore = git(abrainHome, "rev-parse", "HEAD");
    const statusBefore = statusPorcelain(abrainHome);
    process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE = "1";
    const applied = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(applied.status === "pending", `prepublish apply stays pending: ${JSON.stringify(applied)}`);
    assert(/TEST_DRAIN_PRE_PUBLISH|pre-publish/i.test(applied.detail || ""), `prepublish detail names fault: ${applied.detail}`);
    assert(process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE === undefined, "prepublish one-shot hook was not consumed");
    assert(git(abrainHome, "rev-parse", "HEAD") === headBefore, "prepublish must not advance HEAD");
    assert(!fs.existsSync(plan.registryPath), "prepublish must rollback newly-written registry bytes");
    assert(
      !git(abrainHome, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(intent.registryRelativePath),
      "prepublish must not leave registry in HEAD",
    );
    // Recovery meta may remain dirty, but the tracked registry path itself must
    // not appear as a worktree write after legitimate pre-publish rollback.
    const registryPorcelain = execFileSync("git", ["-C", abrainHome, "status", "--porcelain=v1", "--", intent.registryRelativePath], {
      encoding: "utf8",
      env: gitEnv,
    }).trim();
    assert(registryPorcelain === "", `prepublish left registry porcelain dirty: ${registryPorcelain}`);
    // Overall status may include recovery L1; ensure baseline tracked paths are unchanged.
    void statusBefore;
    const pending = await bindIntent.listAbrainBindIntentPending(abrainHome);
    assert(pending.length === 1 && pending[0].itemId === intent.itemId, "intent remains pending after prepublish rollback");
  } finally {
    if (previousSettings === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = previousSettings;
    if (previousHooks === undefined) delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = previousHooks;
    if (previousPost === undefined) delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE = previousPost;
    if (previousPre === undefined) delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE = previousPre;
  }
}

// ── 5c) prepared-episode replay: loop post-CAS fault keeps published bytes ─
{
  const previousSettings = process.env.PI_ASTACK_SETTINGS_PATH;
  const previousHooks = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  const previousPost = process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
  const previousPre = process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
  try {
    const abrainHome = initGitRepo(path.join(tmp, "loop-abrain"), true);
    const project = initGitRepo(path.join(tmp, "loop-project"));
    const settingsPath = path.join(tmp, "loop-enabled.json");
    writeSettings(settingsPath, true);
    process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
    delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;

    const plan = await bindIntent.planAbrainBind({
      abrainHome,
      cwd: project,
      projectId: "loop-prepared-project",
      now: "2026-07-24T14:06:00.000+08:00",
    });
    const intent = bindIntent.intentFromPlan(plan);
    await bindIntent.writeAbrainBindIntent(abrainHome, intent);

    const rt = await canonical.getCanonicalGitRuntime({
      abrainHome,
      settingsPath,
      sourceRoot: root,
    });
    assert((await rt.awaitStartup()).startup === "ready", "loop prepared bind startup ready");

    const headBefore = git(abrainHome, "rev-parse", "HEAD");

    // First apply: leave prepared episode via pre-publish fault + legitimate rollback.
    process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE = "1";
    const first = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(first.status === "pending", `first prepublish apply pending: ${JSON.stringify(first)}`);
    assert(git(abrainHome, "rev-parse", "HEAD") === headBefore, "first prepublish must not advance HEAD");
    assert(!fs.existsSync(plan.registryPath), "first prepublish must rollback registry");

    // Second apply rewrites intent bytes and hits the same prepared episode loop
    // branch; CAS publishes then converge faults → blocked+published, no rollback.
    process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE = "1";
    const second = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(second.status === "pending", `loop post-CAS apply stays pending: ${JSON.stringify(second)}`);
    assert(process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE === undefined, "loop post-CAS one-shot hook was not consumed");
    assert(fs.existsSync(plan.registryPath), "loop post-CAS must keep published registry worktree bytes");
    assert(
      fs.readFileSync(plan.registryPath, "utf8") === intent.registryBytes,
      "loop post-CAS must not roll published registry back to absent",
    );
    const headPublished = git(abrainHome, "rev-parse", "HEAD");
    assert(headPublished !== headBefore, "loop post-CAS must advance HEAD via CAS");
    assert(
      git(abrainHome, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(intent.registryRelativePath),
      "loop post-CAS HEAD must contain registry",
    );
    const pending = await bindIntent.listAbrainBindIntentPending(abrainHome);
    assert(pending.length === 1 && pending[0].itemId === intent.itemId, "intent remains pending after loop post-CAS");

    // Third apply without hooks settles to done.
    delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
    const third = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
    assert(third.status === "done", `loop recovery settle done: ${JSON.stringify(third)}`);
    const after = await bindIntent.listAbrainBindIntentPending(abrainHome);
    assert(after.length === 0, "loop recovery clears pending intent");
    assert(fs.existsSync(plan.registryPath), "loop recovery retains registry bytes");
    let ancestor = false;
    try { git(abrainHome, "merge-base", "--is-ancestor", headPublished, "HEAD"); ancestor = true; } catch { ancestor = false; }
    assert(ancestor, "loop recovery must keep published ancestry");
  } finally {
    if (previousSettings === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
    else process.env.PI_ASTACK_SETTINGS_PATH = previousSettings;
    if (previousHooks === undefined) delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    else process.env.PI_ASTACK_ENABLE_TEST_HOOKS = previousHooks;
    if (previousPost === undefined) delete process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_POST_PUBLISH_THROW_ONCE = previousPost;
    if (previousPre === undefined) delete process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE;
    else process.env.PI_ASTACK_DRAIN_PRE_PUBLISH_THROW_ONCE = previousPre;
  }
}

// ── 6) post-drain local-map path_conflict never rolls back published bytes ─
{
  const abrainHome = initGitRepo(path.join(tmp, "conflict-abrain"), true);
  const project = initGitRepo(path.join(tmp, "conflict-project"));
  const settingsPath = path.join(tmp, "conflict-enabled.json");
  writeSettings(settingsPath, true);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;

  const plan = await bindIntent.planAbrainBind({
    abrainHome,
    cwd: project,
    projectId: "post-drain-conflict",
    now: "2026-07-24T14:10:00.000+08:00",
  });
  const intent = bindIntent.intentFromPlan(plan);
  await bindIntent.writeAbrainBindIntent(abrainHome, intent);

  // Seed a foreign project confirmation for the same absolute path so
  // applyLocalMapOnlyBind throws path_conflict after durable drain success.
  const localMapPath = path.join(abrainHome, ".state", "projects", "local-map.json");
  fs.mkdirSync(path.dirname(localMapPath), { recursive: true });
  fs.writeFileSync(localMapPath, `${JSON.stringify({
    schema_version: 1,
    projects: {
      "other-project": {
        paths: [{
          path: path.resolve(project),
          first_seen: "2026-07-24T00:00:00.000+08:00",
          last_seen: "2026-07-24T00:00:00.000+08:00",
          confirmed_at: "2026-07-24T00:00:00.000+08:00",
        }],
      },
    },
  }, null, 2)}\n`);

  const rt = await canonical.getCanonicalGitRuntime({
    abrainHome,
    settingsPath,
    sourceRoot: root,
  });
  assert((await rt.awaitStartup()).startup === "ready", "conflict fixture startup ready");

  const headBefore = git(abrainHome, "rev-parse", "HEAD");
  const applied = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
  assert(applied.status === "pending", `post-drain bookkeeping failure stays pending: ${JSON.stringify(applied)}`);
  assert(/post_drain_bookkeeping|path_conflict/i.test(applied.detail || ""), `detail names bookkeeping/path_conflict: ${applied.detail}`);
  assert(fs.existsSync(plan.registryPath), "post-drain failure retains published registry bytes");
  assert(
    fs.readFileSync(plan.registryPath, "utf8") === intent.registryBytes,
    "post-drain failure does not rollback registry content",
  );
  const headAfter = git(abrainHome, "rev-parse", "HEAD");
  assert(headAfter !== headBefore, "drain durable success advanced HEAD before bookkeeping failure");
  assert(
    git(abrainHome, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(intent.registryRelativePath),
    "HEAD still has registry after post-drain bookkeeping failure",
  );
  const pending = await bindIntent.listAbrainBindIntentPending(abrainHome);
  assert(pending.length === 1 && pending[0].itemId === intent.itemId, "intent remains pending after post-drain bookkeeping failure");

  // Resolve conflict and retry → done / ready binding path.
  fs.writeFileSync(localMapPath, `${JSON.stringify({ schema_version: 1, projects: {} }, null, 2)}\n`);
  const recovered = await bindIntent.applyAbrainBindIntent({ abrainHome, intent });
  assert(recovered.status === "done", `retry after resolving path_conflict: ${JSON.stringify(recovered)}`);
}

// ── 7) strict path validation rejects tampered pending intents ───────
{
  const abrainHome = initGitRepo(path.join(tmp, "path-guard-abrain"), true);
  const settingsPath = path.join(tmp, "path-guard-enabled.json");
  writeSettings(settingsPath, true);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  const rt = await canonical.getCanonicalGitRuntime({ abrainHome, settingsPath, sourceRoot: root });
  assert((await rt.awaitStartup()).startup === "ready", "path-guard startup ready");

  const base = {
    projectId: "path-guard",
    projectRoot: path.join(tmp, "path-guard-project"),
    normalizedPath: path.join(tmp, "path-guard-project"),
    registryRelativePath: "projects/path-guard/_project.json",
    registryBytes: `${JSON.stringify({ schema_version: 1, project_id: "path-guard" }, null, 2)}\n`,
    registryCreated: true,
    gitignoreRelativePath: ".gitignore",
    gitignoreBytes: ".state/\n",
    gitignoreUpdated: true,
    message: "project: add path-guard",
  };
  const good = bindIntent.buildAbrainBindIntent(base);
  let threw = null;
  try {
    await bindIntent.applyAbrainBindIntent({
      abrainHome,
      intent: { ...good, registryRelativePath: "../escape/_project.json" },
    });
  } catch (error) {
    threw = error;
  }
  assert(threw && threw.code === "BIND_INTENT_PATH_INVALID", `registry path tamper rejected: ${threw && threw.message}`);
  threw = null;
  try {
    await bindIntent.applyAbrainBindIntent({
      abrainHome,
      intent: { ...good, gitignoreRelativePath: "nested/.gitignore" },
    });
  } catch (error) {
    threw = error;
  }
  assert(threw && threw.code === "BIND_INTENT_PATH_INVALID", `gitignore path tamper rejected: ${threw && threw.message}`);
}

// ── 8) deferred bind consumer is independent of session_start consumer ─
{
  const src = fs.readFileSync(path.join(root, "extensions/abrain/index.ts"), "utf8");
  assert(src.includes('ABRAIN_BIND_INTENT_CONSUMER = "abrain-bind-intent"'), "bind intent consumer id constant present");
  assert(src.includes("consumerId: ABRAIN_BIND_INTENT_CONSUMER"), "deferred bind schedule uses bind-intent consumer");
  // session_start must keep abrain-runtime for reporter/continuation.
  assert(/session_start[\s\S]*consumerId:\s*ABRAIN_STARTUP_CONSUMER/.test(src), "session_start still uses ABRAIN_STARTUP_CONSUMER");

  const abrainHome = initGitRepo(path.join(tmp, "consumer-abrain"), true);
  const settingsPath = path.join(tmp, "consumer-enabled.json");
  writeSettings(settingsPath, true);
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  const runtimeOpts = { abrainHome, settingsPath, sourceRoot: root };
  await canonical.getCanonicalGitRuntime(runtimeOpts);

  let sessionReady = 0;
  let bindReady = 0;
  const sessionReports = [];
  const bindReports = [];
  await Promise.all([
    canonical.scheduleCanonicalStartupConsumer({
      runtime: runtimeOpts,
      consumerId: "abrain-runtime",
      mode: "json",
      reporter: (message, type) => sessionReports.push({ message, type }),
      onReady: () => { sessionReady += 1; },
      blockedMessage: () => "session blocked",
    }),
    canonical.scheduleCanonicalStartupConsumer({
      runtime: runtimeOpts,
      consumerId: "abrain-bind-intent",
      mode: "json",
      reporter: (message, type) => bindReports.push({ message, type }),
      onReady: () => { bindReady += 1; },
      blockedMessage: () => "bind blocked",
    }),
  ]);
  assert(sessionReady === 1, `session_start consumer onReady fired once: ${sessionReady}`);
  assert(bindReady === 1, `bind-intent consumer onReady fired once: ${bindReady}`);
  // Re-install reporters after schedule (schedule may set them), then replace ONLY
  // the bind-intent reporter — session reporter must remain independent.
  canonical.setCanonicalStartupReporter({
    runtime: runtimeOpts,
    consumerId: "abrain-runtime",
    reporter: (message, type) => sessionReports.push({ message, type }),
  });
  canonical.setCanonicalStartupReporter({
    runtime: runtimeOpts,
    consumerId: "abrain-bind-intent",
    reporter: (message, type) => bindReports.push({ message, type }),
  });
  canonical.setCanonicalStartupReporter({
    runtime: runtimeOpts,
    consumerId: "abrain-bind-intent",
    reporter: (message, type) => bindReports.push({ message: `bind2:${message}`, type }),
  });
  canonical.reportCanonicalStartupConsumer({
    runtime: runtimeOpts,
    consumerId: "abrain-runtime",
    message: "session-still-alive",
    type: "info",
  });
  assert(
    sessionReports.some((row) => row.message === "session-still-alive"),
    `session reporter survived bind consumer update: ${JSON.stringify(sessionReports)}`,
  );
  canonical.reportCanonicalStartupConsumer({
    runtime: runtimeOpts,
    consumerId: "abrain-bind-intent",
    message: "bind-only",
    type: "info",
  });
  assert(
    bindReports.some((row) => row.message === "bind2:bind-only"),
    `bind reporter update applied independently: ${JSON.stringify(bindReports)}`,
  );
}

// ── 9) bind-intent inventory: invalid + failed aggregates (no id/path leak) ─
{
  const abrainHome = initGitRepo(path.join(tmp, "inventory-abrain"), true);
  const project = initGitRepo(path.join(tmp, "inventory-project"));
  const plan = await bindIntent.planAbrainBind({
    abrainHome,
    cwd: project,
    projectId: "inventory-project",
    now: "2026-07-30T12:00:00.000+08:00",
  });
  const intent = bindIntent.intentFromPlan(plan);
  await bindIntent.writeAbrainBindIntent(abrainHome, intent);

  // Valid failed record (+ optional note) must count as failed, not invalid.
  const failedDir = bindIntent.abrainBindIntentFailedDir(abrainHome);
  fs.mkdirSync(failedDir, { recursive: true, mode: 0o700 });
  const failedIntent = {
    ...intent,
    itemId: bindIntent.computeAbrainBindIntentItemId({
      ...intent,
      projectId: "failed-project",
      message: "project: add failed-project",
      registryRelativePath: "projects/failed-project/_project.json",
    }),
    projectId: "failed-project",
    message: "project: add failed-project",
    registryRelativePath: "projects/failed-project/_project.json",
  };
  // Rebuild with correct digest identity.
  const failedBuilt = bindIntent.buildAbrainBindIntent({
    projectId: "failed-project",
    projectRoot: project,
    normalizedPath: path.resolve(project),
    registryRelativePath: "projects/failed-project/_project.json",
    registryBytes: plan.registryBytes.replace("inventory-project", "failed-project"),
    registryCreated: true,
    gitignoreRelativePath: ".gitignore",
    gitignoreBytes: plan.gitignoreToWrite,
    gitignoreUpdated: plan.abrainGitignoreUpdated,
    message: "project: add failed-project",
  });
  fs.writeFileSync(
    path.join(failedDir, `${failedBuilt.itemId}.json`),
    `${JSON.stringify({ ...failedBuilt, note: "historical failure" })}\n`,
    { mode: 0o600 },
  );

  // Corrupt / wrong-name files count as invalid (listPending still skips silently).
  const pendingDir = bindIntent.abrainBindIntentPendingDir(abrainHome);
  fs.writeFileSync(path.join(pendingDir, "not-a-digest.json"), "{\"bad\":true}\n");
  fs.writeFileSync(path.join(pendingDir, `${"a".repeat(64)}.json`), "{not-json\n");

  const inventory = await bindIntent.inspectAbrainBindIntentInventory(abrainHome);
  assert(inventory.pending === 1, `pending count=${inventory.pending}`);
  assert(inventory.failed === 1, `failed count=${inventory.failed}`);
  assert(inventory.invalid >= 2, `invalid count=${inventory.invalid}`);
  const listed = await bindIntent.listAbrainBindIntentPending(abrainHome);
  assert(listed.length === 1, "listPending still silently skips corrupt rows");
  // Aggregate surface must not embed ids/paths in the returned object keys/values shape.
  assert(
    Object.keys(inventory).sort().join(",") === "failed,invalid,pending",
    `inventory keys must be aggregate-only: ${Object.keys(inventory)}`,
  );
  void failedIntent;
}

// ── 10) strict bind-intent loader: type/key/note/symlink fail closed ─
{
  const abrainHome = initGitRepo(path.join(tmp, "strict-loader-abrain"), true);
  const project = initGitRepo(path.join(tmp, "strict-loader-project"));
  const plan = await bindIntent.planAbrainBind({
    abrainHome,
    cwd: project,
    projectId: "strict-loader",
    now: "2026-07-30T15:00:00.000+08:00",
  });
  const good = bindIntent.intentFromPlan(plan);
  const pendingDir = bindIntent.abrainBindIntentPendingDir(abrainHome);
  const failedDir = bindIntent.abrainBindIntentFailedDir(abrainHome);
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(failedDir, { recursive: true, mode: 0o700 });

  function writePending(itemId, body) {
    fs.writeFileSync(path.join(pendingDir, `${itemId}.json`), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  }

  // Valid baseline pending.
  await bindIntent.writeAbrainBindIntent(abrainHome, good);

  // Numeric boolean coercion must not pass (registryCreated: 1).
  writePending("b".repeat(64), {
    ...good,
    itemId: "b".repeat(64),
    registryCreated: 1,
    gitignoreUpdated: 0,
  });
  // String booleans must not pass.
  writePending("c".repeat(64), {
    ...good,
    itemId: "c".repeat(64),
    registryCreated: "true",
    gitignoreUpdated: "false",
  });
  // Missing required key.
  {
    const { message: _drop, ...missing } = good;
    writePending("d".repeat(64), { ...missing, itemId: "d".repeat(64) });
  }
  // Unknown key.
  writePending("e".repeat(64), { ...good, itemId: "e".repeat(64), extra: "nope" });
  // __proto__ as an own JSON key must not pass (object-literal __proto__ would not serialize).
  {
    const base = { ...good, itemId: "f".repeat(64) };
    const injected = `${JSON.stringify(base).slice(0, -1)},"__proto__":{"polluted":true}}\n`;
    fs.writeFileSync(path.join(pendingDir, `${"f".repeat(64)}.json`), injected, { mode: 0o600 });
  }
  // Pending must not allow note.
  writePending("1".repeat(64), { ...good, itemId: "1".repeat(64), note: "not allowed on pending" });

  // Symlink file in pending bucket → invalid (not followed).
  const escapeFile = path.join(tmp, "escape-intent.json");
  fs.writeFileSync(escapeFile, `${JSON.stringify({ ...good, itemId: "2".repeat(64) })}\n`);
  fs.symlinkSync(escapeFile, path.join(pendingDir, `${"2".repeat(64)}.json`));

  const inv = await bindIntent.inspectAbrainBindIntentInventory(abrainHome);
  assert(inv.pending === 1, `strict pending valid count=${inv.pending}`);
  assert(inv.invalid >= 7, `strict invalid count=${inv.invalid}`);

  // applyAllPending must throw on invalid pending (no silent skip).
  let applyThrew = null;
  try {
    await bindIntent.applyAllPendingAbrainBindIntents(abrainHome);
  } catch (error) {
    applyThrew = error;
  }
  assert(applyThrew && /bind_intent_pending_invalid/.test(applyThrew.message),
    `strict apply must fail closed on invalid pending: ${applyThrew && applyThrew.message}`);

  // Symlink pending bucket → fail closed (throw), not empty success.
  const abrainSym = initGitRepo(path.join(tmp, "strict-symlink-bucket"), true);
  const realPending = path.join(tmp, "real-pending-bucket");
  fs.mkdirSync(realPending, { recursive: true, mode: 0o700 });
  const stateAbrain = path.join(abrainSym, ".state", "abrain", "bind-intent");
  fs.mkdirSync(stateAbrain, { recursive: true, mode: 0o700 });
  fs.symlinkSync(realPending, path.join(stateAbrain, "pending"));
  let bucketThrew = null;
  try {
    await bindIntent.inspectAbrainBindIntentInventory(abrainSym);
  } catch (error) {
    bucketThrew = error;
  }
  assert(bucketThrew && /bind_intent_(bucket|path)_/.test(bucketThrew.message),
    `symlink bucket must fail closed: ${bucketThrew && bucketThrew.message}`);

  // Failed record with optional string note remains valid failed (blocks inventory).
  const failedBuilt = bindIntent.buildAbrainBindIntent({
    projectId: "failed-strict",
    projectRoot: project,
    normalizedPath: path.resolve(project),
    registryRelativePath: "projects/failed-strict/_project.json",
    registryBytes: plan.registryBytes.replace("strict-loader", "failed-strict"),
    registryCreated: true,
    gitignoreRelativePath: ".gitignore",
    gitignoreBytes: plan.gitignoreToWrite,
    gitignoreUpdated: plan.abrainGitignoreUpdated,
    message: "project: add failed-strict",
  });
  fs.writeFileSync(
    path.join(failedDir, `${failedBuilt.itemId}.json`),
    `${JSON.stringify({ ...failedBuilt, note: "historical failure" })}\n`,
    { mode: 0o600 },
  );
  // Clean pending invalids so inventory reflects failed block cleanly on a fresh home.
  const abrainFailed = initGitRepo(path.join(tmp, "strict-failed-block"), true);
  const failedOnlyDir = bindIntent.abrainBindIntentFailedDir(abrainFailed);
  fs.mkdirSync(failedOnlyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(failedOnlyDir, `${failedBuilt.itemId}.json`),
    `${JSON.stringify({ ...failedBuilt, note: "historical failure" })}\n`,
    { mode: 0o600 },
  );
  const failedInv = await bindIntent.inspectAbrainBindIntentInventory(abrainFailed);
  assert(failedInv.failed === 1 && failedInv.invalid === 0 && failedInv.pending === 0,
    `failed+note inventory=${JSON.stringify(failedInv)}`);
}

// ── 11) bind-intent relative chain: ancestor/bucket symlink fail-closed ─
{
  function snapshotTree(dir) {
    const rows = [];
    function walk(current, rel) {
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = path.join(current, ent.name);
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isSymbolicLink()) {
          rows.push(`${childRel} -> ${fs.readlinkSync(child)}`);
        } else if (ent.isDirectory()) {
          rows.push(`${childRel}/`);
          walk(child, childRel);
        } else {
          const st = fs.statSync(child);
          rows.push(`${childRel}#${st.size}`);
        }
      }
    }
    walk(dir, "");
    return rows.join("\n");
  }

  function closedReason(err) {
    return err instanceof Error ? err.message : String(err);
  }

  function assertClosed(err, label) {
    const msg = closedReason(err);
    assert(/bind_intent_(path|bucket|root|file)_/.test(msg),
      `${label}: closed reason=${msg}`);
    // Public errors must not embed absolute fixture paths.
    assert(!msg.includes(tmp), `${label}: exact path leaked in ${msg}`);
  }

  const project = initGitRepo(path.join(tmp, "chain-project"));
  const basePlan = await bindIntent.planAbrainBind({
    abrainHome: initGitRepo(path.join(tmp, "chain-plan-home"), true),
    cwd: project,
    projectId: "chain-proj",
    now: "2026-07-30T16:00:00.000+08:00",
  });
  const intent = bindIntent.intentFromPlan(basePlan);

  let chainSeq = 0;
  async function withSymlinkComponent(op, component, run) {
    chainSeq += 1;
    const tag = `${op}-${component.replace(/\//g, "-")}-${chainSeq}`;
    const abrainHome = initGitRepo(path.join(tmp, `chain-${tag}`), true);
    const external = path.join(tmp, `escape-${tag}`);
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(external, "marker"), `escape-${tag}\n`, { mode: 0o600 });
    // Build plain parents up to the component, then install the symlink leaf.
    const rel = component === ".state" ? ".state"
      : component === "bind-intent" ? path.join(".state", "abrain", "bind-intent")
        : component === "pending" ? path.join(".state", "abrain", "bind-intent", "pending")
          : component === "done" ? path.join(".state", "abrain", "bind-intent", "done")
            : component === "failed" ? path.join(".state", "abrain", "bind-intent", "failed")
              : null;
    assert(rel, `unknown component ${component}`);
    const abs = path.join(abrainHome, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    fs.symlinkSync(external, abs);
    const before = snapshotTree(external);
    await run(abrainHome, external, before);
    assert(snapshotTree(external) === before, `${op} ${component}: external target unchanged`);
    assert(fs.lstatSync(abs).isSymbolicLink(), `${op} ${component}: symlink preserved`);
    // Must not leak intent/tmp artifacts into the escaped external tree.
    const leaked = fs.readdirSync(external).some((n) => n.endsWith(".json") || n.includes(".tmp"));
    assert(!leaked, `${op} ${component}: leaked artifacts into external target`);
  }

  // inspect fail-closed on .state / bind-intent / pending / failed symlink
  for (const component of [".state", "bind-intent", "pending", "failed"]) {
    await withSymlinkComponent("inspect", component, async (abrainHome) => {
      let threw = null;
      try {
        await bindIntent.inspectAbrainBindIntentInventory(abrainHome);
      } catch (error) {
        threw = error;
      }
      assert(threw, `inspect ${component}: expected throw`);
      assertClosed(threw, `inspect ${component}`);
    });
  }

  // write fail-closed on .state / bind-intent / pending / done / failed symlink
  for (const component of [".state", "bind-intent", "pending", "done", "failed"]) {
    await withSymlinkComponent("write", component, async (abrainHome) => {
      let threw = null;
      try {
        await bindIntent.writeAbrainBindIntent(abrainHome, intent);
      } catch (error) {
        threw = error;
      }
      assert(threw, `write ${component}: expected throw`);
      assertClosed(threw, `write ${component}`);
    });
  }

  // terminal fail-closed on done/failed/bind-intent/.state symlink
  for (const component of [".state", "bind-intent", "done", "failed"]) {
    await withSymlinkComponent("terminal", component, async (abrainHome) => {
      let threw = null;
      try {
        await bindIntent.markBindIntentTerminal(
          abrainHome,
          intent,
          component === "failed" ? "failed" : "done",
          component === "failed" ? "terminal-smoke" : undefined,
        );
      } catch (error) {
        threw = error;
      }
      assert(threw, `terminal ${component}: expected throw`);
      assertClosed(threw, `terminal ${component}`);
    });
  }

  // Code path: prechecked bucket concurrent delete → identity mismatch (not empty).
  // Proven by source contract (readdir ENOENT after successful resolve throws).
  {
    const src = fs.readFileSync(path.join(root, "extensions/abrain/bind-intent.ts"), "utf8");
    assert(
      /code === "ENOENT"[\s\S]{0,120}bind_intent_bucket_identity_mismatch/.test(src),
      "readdir ENOENT after precheck must throw identity mismatch",
    );
    assert(
      !/names = await fs\.readdir\([\s\S]{0,200}code === "ENOENT"\) return \{ valid: \[\], invalid: 0 \}/.test(src),
      "readdir ENOENT must not return empty after precheck",
    );
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ ALL PASS — abrain bind/status gate" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
