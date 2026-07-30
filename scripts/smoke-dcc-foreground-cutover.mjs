#!/usr/bin/env node
/**
 * DCC D3/D4 foreground cutover + continuation smoke.
 * Temporary ABRAIN fixtures only — never touch real ~/.abrain.
 *
 * Each scenario runs in a child process so ABRAIN_ROOT module consts and
 * process-global canonical maps stay coherent (no jiti multi-home reuse).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = fileURLToPath(import.meta.url);
const scenario = process.argv[2] || "";

const BRAIN_ZONES = [
  "identity",
  "skills",
  "habits",
  "workflows",
  "projects",
  "knowledge",
  "vault",
  "rules",
];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

function hex40(seed) {
  return crypto.createHash("sha1").update(String(seed)).digest("hex");
}

const OBS_EPOCH = "3";
const OBS_HOLDER = hex64("fg-holder");
const OBS_HEAD = hex40("dcc-fg-ready-head");
const SECRET_PATTERNS = [
  OBS_HOLDER,
  OBS_HEAD,
  "local_executor_epoch",
  "local_executor_holder_nonce",
  "canonical_head",
  "convergence_generation",
  "canonical-convergence",
  "authority.json",
  "attestation.json",
];

function writeSettings(file, body) {
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function defaultSettings() {
  return {
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
    sediment: { executionOwner: "foreground" },
  };
}

function writeAuthority(abrain, overrides = {}) {
  const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "authority.lock"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "authority.json"), `${JSON.stringify({
    schema: "pi-router/local-sediment-executor-authority/v1",
    local_executor_epoch: OBS_EPOCH,
    mode: "held",
    holder_kind: "daemon",
    holder_nonce: OBS_HOLDER,
    state_dir_key: hex64("fg-state"),
    run_nonce: hex64("fg-run"),
    ...overrides,
  })}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(directory, "authority.lock"), 0o600);
    fs.chmodSync(path.join(directory, "authority.json"), 0o600);
  }
}

function writeAttestation(abrain, overrides = {}, raw = undefined) {
  const directory = path.join(abrain, ".state", "sediment", "canonical-convergence");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const value = {
    schema: "pi-astack/canonical-convergence-attestation/v1",
    local_executor_epoch: OBS_EPOCH,
    local_executor_holder_nonce: OBS_HOLDER,
    convergence_generation: "1",
    outcome: "ready",
    reason_code: "none",
    canonical_head: OBS_HEAD,
    published_at_ms: 1_800_000_000_000,
    ...overrides,
  };
  const file = path.join(directory, "attestation.json");
  fs.writeFileSync(file, raw ?? `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return value;
}

function assertNoSecrets(text, label) {
  const hay = typeof text === "string" ? text : JSON.stringify(text);
  for (const needle of SECRET_PATTERNS) {
    assert(!hay.includes(needle), `${label} leaked secret/field ${needle}: ${hay}`);
  }
}

function assertClosedObservation(obs, status, reason, label) {
  assert(obs && typeof obs === "object", `${label}: missing observation`);
  assert(Object.keys(obs).sort().join(",") === "reason_code,status", `${label}: keys=${Object.keys(obs)}`);
  assert(obs.status === status, `${label}: status=${obs.status} expected ${status}`);
  assert(obs.reason_code === reason, `${label}: reason=${obs.reason_code} expected ${reason}`);
  assertNoSecrets(obs, label);
}

/** Prebuild a complete legal brain layout (zones + rules modes + optional gitignore). */
function ensureCompleteBrainLayout(abrain, { gitignore = true } = {}) {
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  for (const zone of BRAIN_ZONES) {
    fs.mkdirSync(path.join(abrain, zone), { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(abrain, "rules", "always"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(abrain, "rules", "listed"), { recursive: true, mode: 0o700 });
  if (gitignore) fs.writeFileSync(path.join(abrain, ".gitignore"), ".state/\n");
}

function initAbrain(base, name, {
  authority = true,
  gitignore = true,
  authorityOverrides = {},
  fullLayout = true,
} = {}) {
  const abrain = path.join(base, name);
  if (fullLayout) ensureCompleteBrainLayout(abrain, { gitignore });
  else {
    fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
    if (gitignore) fs.writeFileSync(path.join(abrain, ".gitignore"), ".state/\n");
  }
  if (authority === true) writeAuthority(abrain, authorityOverrides);
  else if (authority === "corrupt") {
    const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "authority.lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "authority.json"), "{not-json\n", { mode: 0o600 });
  }
  return abrain;
}

function snapshotTree(dir) {
  const rows = [];
  function walk(current, rel = "") {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const next = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) rows.push(`l:${next}->${fs.readlinkSync(full)}`);
      else if (st.isDirectory()) {
        rows.push(`d:${next}`);
        walk(full, next);
      } else rows.push(`f:${next}:${st.size}`);
    }
  }
  walk(dir);
  return rows.join("|");
}

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    api: {
      on(name, handler) {
        const rows = handlers.get(name) ?? [];
        rows.push(handler);
        handlers.set(name, rows);
      },
      registerCommand(name, options) { commands.set(name, options); },
      registerTool() {},
      registerEntryRenderer() {},
      getActiveTools() { return []; },
      getAllTools() { return []; },
      setActiveTools() {},
    },
  };
}

async function loadModules(abrainHome, settingsBody) {
  const settingsPath = path.join(path.dirname(abrainHome), "settings.json");
  writeSettings(settingsPath, settingsBody);
  process.env.ABRAIN_ROOT = abrainHome;
  process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  process.env.PI_ABRAIN_NO_AUTOSYNC = "1";
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const abrain = await jiti.import(path.join(root, "extensions/abrain/index.ts"));
  const canonical = await jiti.import(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  const authority = await jiti.import(path.join(root, "extensions/sediment/local-executor-authority.ts"));
  const bindIntent = await jiti.import(path.join(root, "extensions/abrain/bind-intent.ts"));
  const control = await jiti.import(path.join(root, "extensions/sediment/canonical-control.ts"));
  return { abrain, canonical, authority, bindIntent, control };
}

async function loadObservationModules() {
  process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const control = await jiti.import(path.join(root, "extensions/sediment/canonical-control.ts"));
  const canonical = await jiti.import(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
  return { control, canonical };
}

async function assertZeroDeltaMaps(canonical, label, beforeRuntime, beforePromise, beforeTree, abrainHome) {
  assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, `${label}: runtime map delta`);
  assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, `${label}: promise map delta`);
  assert(snapshotTree(abrainHome) === beforeTree, `${label}: ABRAIN tree delta`);
}

async function observeCase(control, abrainHome, deps = {}) {
  return control.observeForegroundCanonicalConvergence(abrainHome, {
    authorityObservation: { observeLock: () => "held" },
    readCanonicalHead: async () => OBS_HEAD,
    ...deps,
  });
}

async function runSessionStartNoGrowth(abrainHome, label) {
  const { abrain, canonical } = await loadModules(abrainHome, defaultSettings());
  const pi = fakePi();
  const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
  const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
  (abrain.default ?? abrain)(pi.api);
  assert(
    abrain.getAbrainLocalSafetyStatus(abrainHome).status === "ready",
    `${label}: safety not ready (${abrain.getAbrainLocalSafetyStatus(abrainHome).blockedReason || ""})`,
  );
  for (const handler of pi.handlers.get("session_start") ?? []) {
    await handler({ reason: "startup" }, {
      mode: "tui",
      cwd: abrainHome,
      ui: { notify() {} },
    });
  }
  assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, `${label}: runtime map grew`);
  assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, `${label}: promise map grew`);
}

async function runScenario(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-dcc-fg-${name}-`));
  try {
    if (name === "session-capture") {
      // Prebuild complete legal layout; activate must be zero-delta on ABRAIN tree.
      const abrainHome = initAbrain(tmp, "abrain");
      const beforeTree = snapshotTree(abrainHome);
      const { abrain, canonical, authority } = await loadModules(abrainHome, defaultSettings());
      assert(authority.classifyForegroundLocalExecutorPosture(abrainHome) === "capture_only", "store present must be capture_only");
      const pi = fakePi();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      (abrain.default ?? abrain)(pi.api);
      assert(abrain.getAbrainLocalSafetyStatus(abrainHome).status === "ready", "safety not ready");
      for (const handler of pi.handlers.get("session_start") ?? []) {
        await handler({ reason: "startup" }, {
          mode: "tui",
          cwd: abrainHome,
          ui: { notify() {} },
        });
      }
      assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, "runtime map grew");
      assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, "promise map grew");
      assert(snapshotTree(abrainHome) === beforeTree, "capture-only activation mutated ABRAIN tree");
      return;
    }

    if (name === "session-held" || name === "session-free" || name === "session-corrupt") {
      // Actual session_start handler coverage for held/free/corrupt +
      // settings sediment.executionOwner=foreground (does not authorize TUI).
      const authority =
        name === "session-corrupt" ? "corrupt" : true;
      const authorityOverrides =
        name === "session-held" ? { mode: "held" }
          : name === "session-free" ? { mode: "free" }
            : {};
      const abrainHome = initAbrain(tmp, name, { authority, authorityOverrides });
      await runSessionStartNoGrowth(abrainHome, name);
      return;
    }

    if (name === "posture-matrix") {
      // Presence classification only — no abrain/index ABRAIN_HOME const dependency.
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { createJiti } = require("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      const authority = await jiti.import(path.join(root, "extensions/sediment/local-executor-authority.ts"));
      const cases = [
        { name: "held", authority: true, authorityOverrides: { mode: "held" } },
        { name: "free", authority: true, authorityOverrides: { mode: "free" } },
        { name: "corrupt", authority: "corrupt" },
      ];
      for (const item of cases) {
        const abrainHome = initAbrain(tmp, item.name, {
          authority: item.authority,
          authorityOverrides: item.authorityOverrides,
        });
        assert(
          authority.classifyForegroundLocalExecutorPosture(abrainHome) === "capture_only",
          `${item.name} must be capture_only`,
        );
      }
      return;
    }

    if (name === "missing-zone") {
      const abrainHome = initAbrain(tmp, "abrain");
      fs.rmSync(path.join(abrainHome, "knowledge"), { recursive: true, force: true });
      const beforeTree = snapshotTree(abrainHome);
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "blocked", `expected blocked, got ${safety.status}`);
      assert(/brain_layout/i.test(safety.blockedReason || ""), safety.blockedReason);
      assert(!fs.existsSync(path.join(abrainHome, "knowledge")), "capture-only must not recreate missing zone");
      assert(snapshotTree(abrainHome) === beforeTree, "missing-zone path mutated tree");
      return;
    }

    if (name === "zone-symlink") {
      const abrainHome = initAbrain(tmp, "abrain");
      const target = path.join(tmp, "escape-knowledge");
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, "marker"), "escape\n");
      fs.rmSync(path.join(abrainHome, "knowledge"), { recursive: true, force: true });
      fs.symlinkSync(target, path.join(abrainHome, "knowledge"));
      const beforeTarget = snapshotTree(target);
      const beforeTree = snapshotTree(abrainHome);
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "blocked", `expected blocked, got ${safety.status}`);
      assert(/brain_layout/i.test(safety.blockedReason || ""), safety.blockedReason);
      assert(fs.lstatSync(path.join(abrainHome, "knowledge")).isSymbolicLink(), "zone symlink replaced");
      assert(snapshotTree(target) === beforeTarget, "symlink target mutated");
      assert(snapshotTree(abrainHome) === beforeTree, "zone-symlink path mutated abrain tree");
      return;
    }

    if (name === "rules-mode-symlink") {
      const abrainHome = initAbrain(tmp, "abrain");
      const target = path.join(tmp, "escape-rules-always");
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, "marker"), "escape\n");
      fs.rmSync(path.join(abrainHome, "rules", "always"), { recursive: true, force: true });
      fs.symlinkSync(target, path.join(abrainHome, "rules", "always"));
      const beforeTarget = snapshotTree(target);
      const beforeTree = snapshotTree(abrainHome);
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "blocked", `expected blocked, got ${safety.status}`);
      assert(/brain_layout/i.test(safety.blockedReason || ""), safety.blockedReason);
      assert(fs.lstatSync(path.join(abrainHome, "rules", "always")).isSymbolicLink(), "rules mode symlink replaced");
      assert(snapshotTree(target) === beforeTarget, "rules symlink target mutated");
      assert(snapshotTree(abrainHome) === beforeTree, "rules-mode-symlink path mutated abrain tree");
      return;
    }

    if (name === "sync-reject") {
      const abrainHome = initAbrain(tmp, "abrain");
      const { abrain, canonical } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const command = pi.commands.get("abrain");
      assert(command, "abrain command missing");
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const notices = [];
      await command.handler("sync", {
        cwd: abrainHome,
        ui: { notify(message, type) { notices.push({ message, type }); } },
      });
      assert(notices.some((n) => n.type === "warning" && /sync rejected|capture-only/i.test(n.message)), JSON.stringify(notices));
      assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, "sync created runtime");
      assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, "sync created promise");
      assert(snapshotTree(abrainHome) === beforeTree, "sync mutated abrain tree");
      return;
    }

    if (name === "bind-capture") {
      const abrainHome = initAbrain(tmp, "abrain");
      const project = path.join(tmp, "project");
      fs.mkdirSync(project, { recursive: true });
      const { abrain, canonical, bindIntent } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const command = pi.commands.get("abrain");
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const notices = [];
      await command.handler("bind --project=capture-proj", {
        cwd: project,
        ui: { notify(message, type) { notices.push({ message, type }); } },
      });
      const inventory = await bindIntent.inspectAbrainBindIntentInventory(abrainHome);
      assert(inventory.pending === 1 && inventory.failed === 0 && inventory.invalid === 0, JSON.stringify(inventory));
      assert(!fs.existsSync(path.join(abrainHome, "projects", "capture-proj", "_project.json")), "registry written");
      assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, "bind started runtime");
      assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, "bind scheduled startup");
      assert(notices.some((n) => /durable intent|Capture-only/i.test(n.message)), JSON.stringify(notices));
      return;
    }

    if (name === "legacy-session") {
      const abrainHome = initAbrain(tmp, "abrain", { authority: false });
      const { abrain, authority } = await loadModules(abrainHome, defaultSettings());
      assert(authority.classifyForegroundLocalExecutorPosture(abrainHome) === "legacy", "store absent must be legacy");
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const notices = [];
      for (const handler of pi.handlers.get("session_start") ?? []) {
        await handler({ reason: "startup" }, {
          mode: "json",
          cwd: abrainHome,
          ui: { notify(message, type) { notices.push({ message, type }); } },
        });
      }
      // Store-absent legacy still enters historical whole-L1 schedule (may fail later if not a git repo).
      assert(
        notices.some((n) => /canonical startup/i.test(n.message)),
        `legacy session_start did not engage historical path: ${JSON.stringify(notices)}`,
      );
      assert(
        !notices.some((n) => /capture-only/i.test(n.message)),
        "legacy must not emit capture-only deferral",
      );
      return;
    }

    if (name === "missing-gitignore") {
      const abrainHome = initAbrain(tmp, "abrain", { gitignore: false });
      assert(!fs.existsSync(path.join(abrainHome, ".gitignore")), "fixture starts without gitignore");
      const beforeTree = snapshotTree(abrainHome);
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "blocked", `expected blocked, got ${safety.status}`);
      assert(/gitignore|ignore|state/i.test(safety.blockedReason || ""), safety.blockedReason);
      assert(!fs.existsSync(path.join(abrainHome, ".gitignore")), "capture-only must not create tracked .gitignore");
      assert(snapshotTree(abrainHome) === beforeTree, "missing-gitignore mutated tree");
      return;
    }

    if (name === "legacy-gitignore") {
      const abrainHome = initAbrain(tmp, "abrain", { authority: false, gitignore: false });
      assert(!fs.existsSync(path.join(abrainHome, ".gitignore")), "fixture starts without gitignore");
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "ready", `legacy safety blocked: ${safety.blockedReason}`);
      const raw = fs.readFileSync(path.join(abrainHome, ".gitignore"), "utf8");
      assert(/(^|\n)\.state\/?(\n|$)/.test(raw), "legacy must ensure .state/ ignore");
      return;
    }

    if (name === "legacy-absent-root") {
      // Root completely missing must bootstrap as store-absent legacy, not capture_only.
      const abrainHome = path.join(tmp, "absent-root");
      assert(!fs.existsSync(abrainHome), "fixture root must not exist");
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "ready", `absent-root safety blocked: ${safety.blockedReason}`);
      assert(fs.existsSync(abrainHome), "legacy bootstrap must create root");
      assert(fs.existsSync(path.join(abrainHome, "identity")), "legacy bootstrap must create zones");
      const raw = fs.readFileSync(path.join(abrainHome, ".gitignore"), "utf8");
      assert(/(^|\n)\.state\/?(\n|$)/.test(raw), "absent-root legacy must ensure .state/ ignore");
      return;
    }

    if (name === "root-symlink") {
      // Root leaf is a symlink → invalid, not legacy bootstrap. Zero writes; external tree intact.
      const external = path.join(tmp, "escape-root-target");
      fs.mkdirSync(external, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(external, "marker"), "escape-root\n", { mode: 0o600 });
      // Also plant a zone-like tree so a follow-write would be observable.
      fs.mkdirSync(path.join(external, "identity"), { recursive: true, mode: 0o700 });
      const abrainHome = path.join(tmp, "abrain-root-link");
      fs.symlinkSync(external, abrainHome);
      const beforeExternal = snapshotTree(external);
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const safety = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(safety.status === "blocked", `expected blocked, got ${safety.status}`);
      assert(
        safety.blockedReason === "brain_layout_root_invalid",
        `expected brain_layout_root_invalid, got ${safety.blockedReason}`,
      );
      assert(fs.lstatSync(abrainHome).isSymbolicLink(), "root symlink replaced");
      assert(snapshotTree(external) === beforeExternal, "root-symlink path mutated external target");
      assert(!fs.existsSync(path.join(external, ".gitignore")), "legacy ensure followed root symlink");
      return;
    }

    // ── D5 six-condition read-only observation ──────────────────────────

    if (name === "obs-store-absent") {
      const abrainHome = initAbrain(tmp, "abrain", { authority: false });
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "legacy", "not_authorized", name);
      const formatted = control.formatForegroundCanonicalConvergenceObservation(obs);
      assert(/Canonical convergence: legacy/.test(formatted), formatted);
      assert(/reason: not_authorized/.test(formatted), formatted);
      assertNoSecrets(formatted, name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-ready-success") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "ready", "none", name);
      const formatted = control.formatForegroundCanonicalConvergenceObservation(obs);
      assert(/Canonical convergence: ready/.test(formatted), formatted);
      assert(/reason: none/.test(formatted), formatted);
      assertNoSecrets(formatted, name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-lock-free") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome, {
        authorityObservation: { observeLock: () => "free" },
      });
      assertClosedObservation(obs, "blocked", "authority_revoked", name);
      assertNoSecrets(control.formatForegroundCanonicalConvergenceObservation(obs), name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-authority-revoked-mode") {
      const abrainHome = initAbrain(tmp, "abrain", {
        authorityOverrides: { mode: "free", holder_kind: "none" },
      });
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "blocked", "authority_revoked", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-epoch-nonce-mismatch") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome, {
        local_executor_epoch: "9",
        local_executor_holder_nonce: hex64("other-holder"),
      });
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "unavailable", "authority_stale", name);
      const formatted = control.formatForegroundCanonicalConvergenceObservation(obs);
      assertNoSecrets(formatted, name);
      assert(!formatted.includes(hex64("other-holder")), "mismatch nonce leaked");
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-attestation-pending") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome, {
        outcome: "pending",
        reason_code: "startup_running",
        canonical_head: null,
      });
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "blocked", "attestation_not_ready", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-attestation-blocked") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome, {
        outcome: "blocked",
        reason_code: "startup_failed",
        canonical_head: null,
      });
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "blocked", "attestation_not_ready", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-head-mismatch") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const otherHead = hex40("other-live-head");
      const obs = await observeCase(control, abrainHome, {
        readCanonicalHead: async () => otherHead,
      });
      assertClosedObservation(obs, "blocked", "head_mismatch", name);
      const formatted = control.formatForegroundCanonicalConvergenceObservation(obs);
      assert(!formatted.includes(otherHead) && !formatted.includes(OBS_HEAD), "head leaked");
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-attestation-corrupt") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome, {}, "{not-json\n");
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome);
      assertClosedObservation(obs, "unavailable", "attestation_unavailable", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-attestation-changed") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      let headReads = 0;
      const obs = await observeCase(control, abrainHome, {
        readCanonicalHead: async () => {
          headReads += 1;
          // Mutate attestation between authority observe and re-read (stability fail).
          // Different digit length so size-based tree snapshot also moves.
          writeAttestation(abrainHome, {
            published_at_ms: 9,
          });
          return OBS_HEAD;
        },
      });
      assert(headReads === 1, "head must be read once");
      assertClosedObservation(obs, "unavailable", "observation_unstable", name);
      // Tree changed by the test itself (attestation rewrite) — maps must stay zero.
      assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, `${name}: runtime map delta`);
      assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, `${name}: promise map delta`);
      assert(snapshotTree(abrainHome) !== beforeTree, `${name}: fixture rewrite should change tree`);
      return;
    }

    if (name === "obs-windows-failclosed") {
      // Store-present win32: platform fail-closed → attestation_unavailable.
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome, { platform: "win32" });
      assertClosedObservation(obs, "unavailable", "attestation_unavailable", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-windows-store-absent") {
      // Store-absent classifier first: win32 still legacy/not_authorized (not platform failclosed).
      const abrainHome = initAbrain(tmp, "abrain", { authority: false });
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await observeCase(control, abrainHome, { platform: "win32" });
      assertClosedObservation(obs, "legacy", "not_authorized", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "safety-reverify-after-dcc-repair") {
      // Store-present: activation verify-only blocks on missing zone; DCC repair
      // fills layout; assert/re-establish path re-runs verify-only (zero write)
      // so an existing process can recover.
      const abrainHome = initAbrain(tmp, "abrain");
      fs.rmSync(path.join(abrainHome, "knowledge"), { recursive: true, force: true });
      const { abrain } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const blocked = abrain.getAbrainLocalSafetyStatus(abrainHome);
      assert(blocked.status === "blocked", `expected blocked, got ${blocked.status}`);
      assert(/brain_layout/i.test(blocked.blockedReason || ""), blocked.blockedReason);

      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { createJiti } = require("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: true });
      const brainLayout = await jiti.import(path.join(root, "extensions/abrain/brain-layout.ts"));
      brainLayout.repairStorePresentBrainLayoutForAuthorityExecutor(abrainHome);
      assert(fs.existsSync(path.join(abrainHome, "knowledge")), "repair must create knowledge");
      const afterRepairTree = snapshotTree(abrainHome);

      // Re-run verify-only establish (same path assert uses under store-present).
      const refreshed = abrain.establishAbrainLocalSafetyPrerequisites(abrainHome);
      assert(refreshed.status === "ready", `re-verify not ready: ${refreshed.blockedReason}`);
      assert(abrain.getAbrainLocalSafetyStatus(abrainHome).status === "ready", "cache not ready after re-verify");
      assert(snapshotTree(abrainHome) === afterRepairTree, "re-verify must remain zero-write");
      return;
    }

    if (name === "obs-hooks-gated") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { control, canonical } = await loadObservationModules();
      delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const obs = await control.observeForegroundCanonicalConvergence(abrainHome, {
        authorityObservation: { observeLock: () => "held" },
        readCanonicalHead: async () => OBS_HEAD,
      });
      process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
      assertClosedObservation(obs, "unavailable", "attestation_unavailable", name);
      await assertZeroDeltaMaps(canonical, name, beforeRuntime, beforePromise, beforeTree, abrainHome);
      return;
    }

    if (name === "obs-linux-real-flock") {
      if (process.platform !== "linux" || !fs.existsSync("/usr/bin/flock")) {
        console.log("        skip native flock (non-Linux runner)");
        return;
      }
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const lockPath = path.join(
        abrainHome,
        ".state",
        "sediment",
        "local-executor-authority",
        "authority.lock",
      );
      const { control, canonical } = await loadObservationModules();
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      const holder = spawn("/usr/bin/flock", ["-F", "-x", lockPath, "/bin/sleep", "20"], {
        stdio: "ignore",
      });
      try {
        const deadline = Date.now() + 5_000;
        let ready = null;
        while (Date.now() < deadline) {
          const obs = await control.observeForegroundCanonicalConvergence(abrainHome, {
            readCanonicalHead: async () => OBS_HEAD,
          });
          if (obs.status === "ready" && obs.reason_code === "none") {
            ready = obs;
            break;
          }
          if (obs.status === "blocked" && obs.reason_code === "authority_revoked") {
            await new Promise((r) => setTimeout(r, 20));
            continue;
          }
          // Other fail-closed results are unexpected for held flock + ready attestation.
          throw new Error(`unexpected observation while waiting for flock: ${JSON.stringify(obs)}`);
        }
        assert(ready, "native flock holder was not observed as ready");
        assertClosedObservation(ready, "ready", "none", name);
        assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, `${name}: runtime map delta`);
        assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, `${name}: promise map delta`);
        assert(snapshotTree(abrainHome) === beforeTree, `${name}: ABRAIN tree delta under flock`);
      } finally {
        holder.kill("SIGKILL");
        await new Promise((resolve) => holder.once("close", resolve));
      }
      // After release, physical lock free → fail closed (not ready).
      const releasedDeadline = Date.now() + 5_000;
      let released = false;
      while (Date.now() < releasedDeadline) {
        const obs = await control.observeForegroundCanonicalConvergence(abrainHome, {
          readCanonicalHead: async () => OBS_HEAD,
        });
        if (obs.status === "blocked" && obs.reason_code === "authority_revoked") {
          released = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(released, "native flock release was not observed as authority_revoked");
      return;
    }

    if (name === "obs-status-command") {
      const abrainHome = initAbrain(tmp, "abrain");
      writeAttestation(abrainHome);
      const { abrain, control, canonical } = await loadModules(abrainHome, defaultSettings());
      const pi = fakePi();
      (abrain.default ?? abrain)(pi.api);
      const command = pi.commands.get("abrain");
      assert(command, "abrain command missing");
      const beforeRuntime = canonical.__canonicalRuntimeMapSizeForTests();
      const beforePromise = canonical.__canonicalStartupPromiseMapSizeForTests();
      const beforeTree = snapshotTree(abrainHome);
      // /abrain status uses production observation (no inject). Without real flock
      // holder this store-present fixture fails closed — still closed aggregate only.
      const notices = [];
      await command.handler("status", {
        cwd: abrainHome,
        ui: { notify(message, type) { notices.push({ message, type }); } },
      });
      const conv = notices.find((n) => /Canonical convergence:/.test(n.message));
      assert(conv, `status missing convergence aggregate: ${JSON.stringify(notices)}`);
      assert(/Canonical convergence: (ready|blocked|legacy|unavailable)/.test(conv.message), conv.message);
      assert(/reason: [a-z_]+/.test(conv.message), conv.message);
      assertNoSecrets(conv.message, name);
      // Must not start Path A / create runtime or promises.
      assert(canonical.__canonicalRuntimeMapSizeForTests() === beforeRuntime, `${name}: runtime map delta`);
      assert(canonical.__canonicalStartupPromiseMapSizeForTests() === beforePromise, `${name}: promise map delta`);
      assert(snapshotTree(abrainHome) === beforeTree, `${name}: ABRAIN tree delta`);
      // Sanitize path freezes closed shape.
      const sanitized = control.sanitizeForegroundCanonicalConvergenceObservation({
        status: "blocked",
        reason_code: "head_mismatch",
      });
      assert(sanitized?.status === "blocked" && sanitized.reason_code === "head_mismatch", "sanitize ready path");
      assert(control.sanitizeForegroundCanonicalConvergenceObservation({
        status: "ready",
        reason_code: "head_mismatch",
      }) === null, "sanitize must reject illegal ready+mismatch");
      assert(control.sanitizeForegroundCanonicalConvergenceObservation({
        status: "ready",
        reason_code: "none",
        canonical_head: OBS_HEAD,
      }) === null, "sanitize must reject extra secret fields");
      return;
    }

    throw new Error(`unknown scenario: ${name}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (scenario) {
  await runScenario(scenario);
  console.log(`SCENARIO_OK ${scenario}`);
  process.exit(0);
}

const scenarios = [
  "session-capture",
  "session-held",
  "session-free",
  "session-corrupt",
  "posture-matrix",
  "missing-zone",
  "zone-symlink",
  "rules-mode-symlink",
  "sync-reject",
  "bind-capture",
  "legacy-session",
  "missing-gitignore",
  "legacy-gitignore",
  "legacy-absent-root",
  "root-symlink",
  // D5 six-condition observation
  "obs-store-absent",
  "obs-ready-success",
  "obs-lock-free",
  "obs-authority-revoked-mode",
  "obs-epoch-nonce-mismatch",
  "obs-attestation-pending",
  "obs-attestation-blocked",
  "obs-head-mismatch",
  "obs-attestation-corrupt",
  "obs-attestation-changed",
  "obs-windows-failclosed",
  "obs-windows-store-absent",
  "safety-reverify-after-dcc-repair",
  "obs-hooks-gated",
  "obs-linux-real-flock",
  "obs-status-command",
];

let passed = 0;
for (const name of scenarios) {
  const result = spawnSync(process.execPath, [self, name], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 120_000,
  });
  if (result.status !== 0 || !result.stdout.includes(`SCENARIO_OK ${name}`)) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`scenario failed: ${name} (status=${result.status})`);
  }
  passed += 1;
  console.log(`  ok    ${name}`);
}

console.log(`\n${passed} checks passed`);
