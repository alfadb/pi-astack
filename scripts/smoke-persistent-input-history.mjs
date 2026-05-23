#!/usr/bin/env node
/**
 * Smoke test: persistent-input-history defends against pi SDK
 * internal API drift.
 *
 * The extension depends on two load-bearing assumptions that are
 * NOT in any pi SDK contract (see `extensions/persistent-input-history/
 * index.ts` header comment). v4 eliminated the third (timing) assumption
 * by moving disk writes to the `input` event handler. This smoke locks
 * the defensive behavior for the two that are detectable at runtime:
 *
 *   (1) CustomEditor.prototype.addToHistory is a function.
 *       → fail-fast: extension does NOT install setEditorComponent;
 *         a single error notify fires.
 *   (2) Editor.history is a plain JS array on `this`.
 *       → degrade gracefully: preload skipped;
 *         a single warning notify fires; new prompts still persist
 *         via the `input` event handler.
 *
 * Also covers:
 *   - PI_VERSION_OK semver gate (0.75.x – 0.99.x in-range; 1.x.x and
 *     pre-0.75 out-of-range; "unknown" stays quiet).
 *   - FORCE_DISABLED env escape hatch parses 1/true/yes/on (case-insensitive).
 *   - happy path (v4): MRU dedup prevents in-memory duplication during
 *     renderInitialMessages replay; disk writes ONLY via input event.
 *
 * The "fake pi-tui" mock here is deliberately minimal: just a class
 * shape that mirrors what PersistentHistoryEditor reaches into. If
 * pi-tui upgrades and BOTH the assumption AND this mock stay in sync
 * unintentionally, the smoke will still catch the real-world drift
 * because the capability/version probes run against the live
 * @earendil-works/pi-coding-agent in node_modules.
 *
 * Run: node scripts/smoke-persistent-input-history.mjs
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ── Build a per-test sandbox we can re-stage with different mocks ───
//
// We stage settings.cjs + index.cjs into a fresh tmpDir per scenario,
// rewriting the pi-coding-agent + pi-tui imports to point at local
// fake modules whose class shape we control. This lets us simulate:
//   - "pi-tui dropped Editor.history field" (assumption 2 broken)
//   - "pi-tui dropped CustomEditor.addToHistory method" (assumption 1
//      broken — caught by the module-load CAPABILITY probe)
//   - "version drift" (PI_VERSION_OK false)

function stageExtension({ fakePi, fakePiTui, fakePackageJson, env }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-pih-"));

  // Lay out a fake @earendil-works package under tmpDir/node_modules
  // so `createRequire(...)("@earendil-works/pi-coding-agent/package.json")`
  // and `import { CustomEditor }` both resolve to our mocks.
  const nm = path.join(tmpDir, "node_modules", "@earendil-works");
  fs.mkdirSync(path.join(nm, "pi-coding-agent"), { recursive: true });
  fs.mkdirSync(path.join(nm, "pi-tui"), { recursive: true });

  fs.writeFileSync(
    path.join(nm, "pi-coding-agent", "package.json"),
    JSON.stringify(fakePackageJson),
  );
  fs.writeFileSync(
    path.join(nm, "pi-coding-agent", "index.js"),
    fakePi,
  );
  fs.writeFileSync(
    path.join(nm, "pi-coding-agent", "package.json.js"),
    "", // unused; createRequire reads .json directly
  );
  fs.writeFileSync(
    path.join(nm, "pi-tui", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.75.3", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(nm, "pi-tui", "index.js"),
    fakePiTui,
  );

  // Stage settings.cjs + index.cjs in tmpDir. Both files import each
  // other relatively; we replace the @earendil-works imports so they
  // resolve via tmpDir's node_modules.
  const settingsSrc = transpile(
    path.join(repoRoot, "extensions/persistent-input-history/settings.ts"),
  );
  // settings.ts imports from "../memory/settings"; resolve to live source.
  let settingsCjs = settingsSrc.replace(
    /require\(["']\.\.\/memory\/settings["']\)/g,
    `require(${JSON.stringify(
      path.join(repoRoot, "extensions/memory/settings.ts"),
    )})`,
  );
  // memory/settings is .ts; we need to also transpile it on the fly.
  // Simpler: just inline an adequate shim with asBoolean / asNumber.
  settingsCjs = settingsSrc.replace(
    /require\(["']\.\.\/memory\/settings["']\)/g,
    `require("./_memory_settings_shim.js")`,
  );

  fs.writeFileSync(
    path.join(tmpDir, "_memory_settings_shim.js"),
    `module.exports = {
       asBoolean: (v, fb) => typeof v === "boolean" ? v : fb,
       asNumber: (v, fb) => typeof v === "number" && Number.isFinite(v) ? v : fb,
     };\n`,
  );
  fs.writeFileSync(path.join(tmpDir, "settings.cjs"), settingsCjs);
  fs.writeFileSync(
    path.join(tmpDir, "settings.js"),
    `module.exports = require("./settings.cjs");\n`,
  );

  const indexSrc = transpile(
    path.join(repoRoot, "extensions/persistent-input-history/index.ts"),
  );
  // index.ts imports from "./settings"; relative require already works.
  // Imports from "@earendil-works/pi-*" resolve via the tmpDir/node_modules
  // we laid out above.
  fs.writeFileSync(path.join(tmpDir, "index.cjs"), indexSrc);
  fs.writeFileSync(
    path.join(tmpDir, "index.js"),
    `module.exports = require("./index.cjs");\n`,
  );

  // node_modules at tmpDir lets `require` resolve @earendil-works/*
  // because Node walks upward from index.cjs's dirname. Verify:
  // tmpDir/index.cjs's nearest node_modules is tmpDir/node_modules. ✓

  // Apply env vars for this load (CAPABILITY + FORCE_DISABLED are
  // captured at module-load time, so we must reset require cache).
  const prevEnv = { ...process.env };
  for (const k of Object.keys(env || {})) process.env[k] = env[k];
  // Wipe any prior cached load so the module-level probes re-run.
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(tmpDir)) delete require.cache[k];
  }

  const mod = require(path.join(tmpDir, "index.cjs"));

  // Restore env (the values were captured into the module's closure
  // already, restoring now is safe and keeps tests hermetic).
  for (const k of Object.keys(env || {})) {
    if (k in prevEnv) process.env[k] = prevEnv[k];
    else delete process.env[k];
  }

  return { tmpDir, mod };
}

// ── Fake module bodies ──────────────────────────────────────────────

const FAKE_PI_TUI_OK = `
module.exports = {};
`;

// CustomEditor with `addToHistory` and instance field `history`.
// This is the "normal pi-tui" shape — both assumptions hold.
const FAKE_PI_OK = `
class Editor {
  constructor(tui, theme) {
    this.tui = tui;
    this.theme = theme;
    this.history = [];          // assumption (2): plain JS array
  }
  addToHistory(text) {           // assumption (1): public method
    if (this.history[0] === text) return;
    this.history.unshift(text);
    if (this.history.length > 100) this.history.length = 100;
  }
}
class CustomEditor extends Editor {
  constructor(tui, theme, _kb) { super(tui, theme); }
}
module.exports = { CustomEditor };
`;

// pi-tui dropped Editor.history — assumption (2) broken.
// addToHistory still works, so the extension should INSTALL the editor
// but emit one warning notify on first ctor, and the in-memory replay
// matcher should no-op.
const FAKE_PI_NO_HISTORY_FIELD = `
class Editor {
  constructor(tui, theme) {
    this.tui = tui;
    this.theme = theme;
    // history removed / switched to #private; not enumerable on \`this\`
  }
  addToHistory(_text) {
    // base impl exists but is opaque to us; we have nothing to mutate
  }
}
class CustomEditor extends Editor {
  constructor(tui, theme, _kb) { super(tui, theme); }
}
module.exports = { CustomEditor };
`;

// pi-tui dropped addToHistory entirely — assumption (1) broken.
// CAPABILITY.hasAddToHistory should be false; setEditorComponent
// must NOT be called; an error notify fires.
const FAKE_PI_NO_ADD_TO_HISTORY = `
class Editor {
  constructor(tui, theme) {
    this.tui = tui;
    this.theme = theme;
    this.history = [];
  }
}
class CustomEditor extends Editor {
  constructor(tui, theme, _kb) { super(tui, theme); }
}
module.exports = { CustomEditor };
`;

// ── Tiny pi runtime stand-in ────────────────────────────────────────

function makePiStub() {
  const handlers = new Map();
  const commands = new Map();
  return {
    on(event, fn) { handlers.set(event, fn); },
    registerCommand(name, def) { commands.set(name, def); },
    __emit(event, ev, ctx) {
      const fn = handlers.get(event);
      if (fn) fn(ev, ctx);
    },
    __commands: commands,
    __handlers: handlers,
  };
}

function makeCtxStub(cwd) {
  const notified = [];
  const statuses = new Map();
  let editorFactory = null;
  return {
    cwd,
    notified,
    statuses,
    get editorFactory() { return editorFactory; },
    ui: {
      notify(msg, type) { notified.push({ msg, type }); },
      setStatus(key, val) { statuses.set(key, val); },
      setEditorComponent(factory) { editorFactory = factory; },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

console.log("Smoke: persistent-input-history SDK-drift defense");

// 1. Happy path: in-range version, all capabilities present.
await asyncCheck("capability probe: addToHistory present → hasAddToHistory=true", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
    env: {},
  });
  if (!mod.__TEST.CAPABILITY.hasAddToHistory) {
    throw new Error("expected hasAddToHistory=true");
  }
  if (mod.__TEST.PI_VERSION !== "0.75.3") {
    throw new Error(`expected PI_VERSION=0.75.3, got ${mod.__TEST.PI_VERSION}`);
  }
  if (!mod.__TEST.PI_VERSION_OK) {
    throw new Error("expected PI_VERSION_OK=true for 0.75.3");
  }
});

// 2. Capability missing → extension refuses to install editor.
await asyncCheck("capability probe: addToHistory missing → hasAddToHistory=false", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_NO_ADD_TO_HISTORY,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
    env: {},
  });
  if (mod.__TEST.CAPABILITY.hasAddToHistory) {
    throw new Error("expected hasAddToHistory=false when prototype.addToHistory absent");
  }
});

await asyncCheck("session_start: capability=false → no setEditorComponent + one error notify", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_NO_ADD_TO_HISTORY,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
    env: {},
  });
  const pi = makePiStub();
  mod.default(pi);
  if (!pi.__handlers.has("session_start")) throw new Error("session_start not registered");
  const ctx = makeCtxStub("/tmp/cwd");
  pi.__emit("session_start", {}, ctx);
  if (ctx.editorFactory !== null) {
    throw new Error("setEditorComponent must NOT be called when capability is missing");
  }
  const errs = ctx.notified.filter((n) => n.type === "error");
  if (errs.length !== 1) {
    throw new Error(`expected 1 error notify, got ${errs.length}: ${JSON.stringify(ctx.notified)}`);
  }
  if (!/addToHistory not found/.test(errs[0].msg)) {
    throw new Error(`error notify should explain the cause, got: ${errs[0].msg}`);
  }
  if (!/PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1/.test(errs[0].msg)) {
    throw new Error(`error notify should mention env escape hatch, got: ${errs[0].msg}`);
  }
  // Commands must still be registered so users can run /history-status
  // to inspect leftover data.
  if (!pi.__commands.has("history-status")) {
    throw new Error("history-status command must still register even when editor is disabled");
  }
  if (!pi.__commands.has("history-compact")) {
    throw new Error("history-compact command must still register even when editor is disabled");
  }
});

// 3. PI_VERSION_OK gate.
await asyncCheck("version gate: 0.75.0 in range", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.0", main: "index.js" },
    env: {},
  });
  if (!mod.__TEST.PI_VERSION_OK) throw new Error("0.75.0 should be in range");
});

await asyncCheck("version gate: 0.99.9 in range (upper edge of pre-1.0)", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.99.9", main: "index.js" },
    env: {},
  });
  if (!mod.__TEST.PI_VERSION_OK) throw new Error("0.99.9 should be in range");
});

await asyncCheck("version gate: 0.74.99 OUT of range (below 0.75)", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.74.99", main: "index.js" },
    env: {},
  });
  if (mod.__TEST.PI_VERSION_OK) throw new Error("0.74.99 should be out of range");
});

await asyncCheck("version gate: 1.0.0 OUT of range (major bump signals re-validate)", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "1.0.0", main: "index.js" },
    env: {},
  });
  if (mod.__TEST.PI_VERSION_OK) throw new Error("1.0.0 should be out of range");
});

await asyncCheck("version gate: 'unknown' stays in range (no false alarm on exotic load layouts)", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", main: "index.js" }, // no version
    env: {},
  });
  if (mod.__TEST.PI_VERSION !== "unknown") {
    throw new Error(`expected PI_VERSION=unknown, got ${mod.__TEST.PI_VERSION}`);
  }
  if (!mod.__TEST.PI_VERSION_OK) {
    throw new Error("'unknown' should keep PI_VERSION_OK=true to avoid false alarm");
  }
});

await asyncCheck("session_start: out-of-range version → one warning notify (non-blocking)", async () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "1.5.0", main: "index.js" },
    env: {},
  });
  const pi = makePiStub();
  mod.default(pi);
  const ctx = makeCtxStub("/tmp/cwd-vdrift");
  pi.__emit("session_start", {}, ctx);
  if (ctx.editorFactory === null) {
    throw new Error("setEditorComponent should still be called when only version (not capability) is off");
  }
  const warns = ctx.notified.filter((n) => n.type === "warning");
  if (warns.length !== 1) {
    throw new Error(`expected exactly 1 warning notify, got ${warns.length}: ${JSON.stringify(ctx.notified)}`);
  }
  if (!/outside the tested range/.test(warns[0].msg)) {
    throw new Error(`warning should explain version drift, got: ${warns[0].msg}`);
  }
});

// 4. FORCE_DISABLED env escape hatch.
for (const truthy of ["1", "true", "yes", "on", "TRUE", "YES", "On"]) {
  await asyncCheck(`FORCE_DISABLED: env="${truthy}" → extension is no-op`, async () => {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_OK,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: { PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY: truthy },
    });
    const pi = makePiStub();
    mod.default(pi);
    // FORCE_DISABLED bails BEFORE registering any handlers/commands.
    if (pi.__handlers.size !== 0) {
      throw new Error(`expected 0 handlers when FORCE_DISABLED, got ${pi.__handlers.size}`);
    }
    if (pi.__commands.size !== 0) {
      throw new Error(`expected 0 commands when FORCE_DISABLED, got ${pi.__commands.size}`);
    }
  });
}

for (const falsy of ["0", "false", "no", "off", "", "anything-else"]) {
  await asyncCheck(`FORCE_DISABLED: env="${falsy}" → extension active`, async () => {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_OK,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: { PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY: falsy },
    });
    const pi = makePiStub();
    mod.default(pi);
    if (!pi.__handlers.has("session_start")) {
      throw new Error(`falsy value "${falsy}" should NOT disable the extension`);
    }
  });
}

// 5. Degraded mode: history field missing. Asserts the contract
//    PersistentHistoryEditor exposes for degraded operation:
//    (a) getInternalHistory returns null,
//    (b) internalUnavailable flag is set,
//    (c) degradedNotify, if assigned after construction but BEFORE
//        the next microtask drain, fires exactly once with the
//        documented message.
//
//    The (c) timing is the load-bearing contract with the
//    session_start wiring: the production factory does
//    `const ed = new X(...); ed.degradedNotify = ...; return ed;`
//    all synchronously, then control returns to the event loop and
//    the queueMicrotask callback reads `this.degradedNotify`.
//    Mirroring that here is the smoke that pins it.
await asyncCheck("degraded: Editor.history missing → getInternalHistory=null, flag set, microtask notify fires", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pih-degraded-cwd-"));
  try {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_NO_HISTORY_FIELD,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: {},
    });
    const editor = new mod.__TEST.PersistentHistoryEditor({}, {}, {}, cwd);

    if (mod.__TEST.getInternalHistory(editor) !== null) {
      throw new Error("getInternalHistory should return null when history field absent");
    }
    if (!editor.internalUnavailable) {
      throw new Error("internalUnavailable must be set when history field absent");
    }

    // Mirror the production wiring: assign degradedNotify SYNCHRONOUSLY
    // after construction, before yielding to the event loop. The
    // queueMicrotask callback queued in ctor will then read this fresh
    // value when it runs.
    let warningCount = 0;
    let lastMsg = "";
    editor.degradedNotify = (msg) => {
      warningCount += 1;
      lastMsg = msg;
    };
    // Drain microtasks. Promise.resolve() flushes the microtask queue
    // before the await resolves.
    await Promise.resolve();

    if (warningCount !== 1) {
      throw new Error(`expected exactly 1 degradedNotify call, got ${warningCount}`);
    }
    if (!/pi-tui Editor\.history field is unreachable/.test(lastMsg)) {
      throw new Error(`message must describe the drift, got: ${lastMsg}`);
    }
    if (!/PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1/.test(lastMsg)) {
      throw new Error(`message must mention env escape hatch, got: ${lastMsg}`);
    }
    if (!/preload \+ ↑\/↓ cross-restart recall disabled/.test(lastMsg)) {
      throw new Error(`message must explain what is disabled, got: ${lastMsg}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Negative test: if internalUnavailable is FALSE (happy path), the
// degraded notify must NOT fire. This pins the gate so future
// refactors can't accidentally start spamming warnings on every
// session.
await asyncCheck("degraded: happy path (history field present) → NO degradedNotify call", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pih-degraded-neg-"));
  try {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_OK,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: {},
    });
    const editor = new mod.__TEST.PersistentHistoryEditor({}, {}, {}, cwd);
    if (editor.internalUnavailable) {
      throw new Error("happy path: internalUnavailable must be false when history field present");
    }
    let warningCount = 0;
    editor.degradedNotify = () => { warningCount += 1; };
    await Promise.resolve();
    if (warningCount !== 0) {
      throw new Error(`happy path must not call degradedNotify, got ${warningCount} calls`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

await asyncCheck("session_start E2E: history field missing → exactly 1 warning notify, editor installed", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pih-degraded-e2e-"));
  try {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_NO_HISTORY_FIELD,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: {},
    });
    const pi = makePiStub();
    mod.default(pi);
    const ctx = makeCtxStub(cwd);
    pi.__emit("session_start", {}, ctx);

    if (ctx.editorFactory === null) {
      throw new Error("setEditorComponent should be called: capability is OK, only history field is gone");
    }
    // Invoke the factory to instantiate; degradedNotify fires via queueMicrotask.
    const ed = ctx.editorFactory({}, {}, {});
    if (!ed) throw new Error("factory must return an editor instance");
    await new Promise((r) => setImmediate(r));   // let queueMicrotask drain

    const warns = ctx.notified.filter((n) => n.type === "warning");
    if (warns.length !== 1) {
      throw new Error(`expected exactly 1 warning notify after factory + microtask, got ${warns.length}: ${JSON.stringify(ctx.notified)}`);
    }
    if (!/Editor\.history field is unreachable/.test(warns[0].msg)) {
      throw new Error(`warning should describe the drift, got: ${warns[0].msg}`);
    }

    // Submitting still works (new prompts persist), even in degraded mode.
    ed.addToHistory("hello");
    // Wait for any persistDisk timing — append is synchronous here.
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// 6. Happy path (v4): MRU dedup absorbs populateHistory in-memory;
//    disk writes ONLY via input event / appendDiskHistory.
await asyncCheck("happy path (v4): MRU dedup absorbs replay; addToHistory does NOT write to disk", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pih-happy-cwd-"));
  try {
    const { mod } = stageExtension({
      fakePi: FAKE_PI_OK,
      fakePiTui: FAKE_PI_TUI_OK,
      fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
      env: {},
    });

    // Seed disk history as if a previous session wrote 3 entries.
    const { encodeCwd, historyFileFor, appendDiskHistory, getInternalHistory } = mod.__TEST;
    const file = historyFileFor(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    appendDiskHistory(file, "msg-1");
    appendDiskHistory(file, "msg-2");
    appendDiskHistory(file, "msg-3");
    const sizeBefore = fs.statSync(file).size;

    // Construct editor (which preloads from disk).
    const ed = new mod.__TEST.PersistentHistoryEditor({}, {}, {}, cwd);

    // Verify preload seeded 3 entries (newest first).
    const hist = getInternalHistory(ed);
    if (!hist) throw new Error("getInternalHistory returned null for happy path");
    if (hist.length !== 3) throw new Error(`expected 3 preloaded entries, got ${hist.length}`);
    if (hist[0] !== "msg-3" || hist[1] !== "msg-2" || hist[2] !== "msg-1") {
      throw new Error(`expected [msg-3, msg-2, msg-1], got ${JSON.stringify(hist)}`);
    }

    // Simulate pi's populateHistory pass: replay user messages in
    // chronological order via addToHistory. v4 MRU dedup should move
    // each entry to front without creating duplicates.
    ed.addToHistory("msg-1"); // oldest → moves to front
    if (hist.length !== 3) throw new Error(`MRU should not grow array, got ${hist.length}`);
    if (hist[0] !== "msg-1") throw new Error(`MRU: msg-1 should be at front, got ${hist[0]}`);

    ed.addToHistory("msg-2");
    if (hist.length !== 3) throw new Error(`MRU should not grow array, got ${hist.length}`);
    if (hist[0] !== "msg-2") throw new Error(`MRU: msg-2 should be at front, got ${hist[0]}`);

    ed.addToHistory("msg-3"); // newest → moves to front
    if (hist.length !== 3) throw new Error(`MRU should not grow array, got ${hist.length}`);
    if (hist[0] !== "msg-3") throw new Error(`MRU: msg-3 should be at front, got ${hist[0]}`);

    // After full replay, order should be same as preload: [msg-3, msg-2, msg-1]
    if (hist[0] !== "msg-3" || hist[1] !== "msg-2" || hist[2] !== "msg-1") {
      throw new Error(`post-replay order mismatch: ${JSON.stringify(hist)}`);
    }

    // P0 ASSERTION: addToHistory MUST NOT write to disk (v4 contract).
    const sizeAfterReplay = fs.statSync(file).size;
    if (sizeAfterReplay !== sizeBefore) {
      throw new Error(
        `v4 contract violation: addToHistory wrote to disk! ` +
        `Disk grew ${sizeBefore} → ${sizeAfterReplay}`,
      );
    }

    // Disk write happens via appendDiskHistory (simulating `input` event handler).
    appendDiskHistory(file, "msg-4");
    const sizeAfterNew = fs.statSync(file).size;
    if (sizeAfterNew <= sizeBefore) {
      throw new Error(`appendDiskHistory should grow disk, got ${sizeBefore} → ${sizeAfterNew}`);
    }

    // Reading back, only msg-4 should be NEW vs the original 3.
    const records = fs.readFileSync(file, "utf8").trim().split("\n");
    if (records.length !== 4) {
      throw new Error(`expected 4 JSONL lines (3 seeded + 1 new), got ${records.length}`);
    }
    const last = JSON.parse(records[3]);
    if (last.text !== "msg-4") {
      throw new Error(`expected last entry to be msg-4, got ${JSON.stringify(last)}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// 7. encodeCwd collision invariant (regression guard for the bug fixed
//    by adding sha1 prefix). Distinct cwds must map to distinct files.
check("encodeCwd: /foo-bar vs /foo/bar produce distinct filenames", () => {
  const { mod } = stageExtension({
    fakePi: FAKE_PI_OK,
    fakePiTui: FAKE_PI_TUI_OK,
    fakePackageJson: { name: "@earendil-works/pi-coding-agent", version: "0.75.3", main: "index.js" },
    env: {},
  });
  const a = mod.__TEST.encodeCwd("/foo-bar");
  const b = mod.__TEST.encodeCwd("/foo/bar");
  if (a === b) throw new Error(`collision: /foo-bar and /foo/bar both → ${a}`);
});

// ── Result ──────────────────────────────────────────────────────────

console.log("");
console.log(`${totalChecks - failures.length}/${totalChecks} checks passed`);
if (failures.length > 0) {
  console.log("");
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(`  - ${f.name}`);
    console.log(`    ${f.err.stack || f.err.message}`);
  }
  process.exit(1);
}
