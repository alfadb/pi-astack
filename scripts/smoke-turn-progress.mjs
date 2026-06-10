#!/usr/bin/env node
/**
 * smoke-turn-progress — verifies the turn-progress extension's two
 * layers don't break pi's contract and don't regress on review feedback.
 *
 * Coverage matrix:
 *
 *   A. extractShortName edge cases (pure)
 *
 *   B. Layer B mirror behaviour equivalence vs. a baseline that
 *      reproduces pi's loop:
 *        B1 no-mutation → undefined
 *        B2 systemPrompt accumulation across extensions, intra-ext
 *           handler threading, message merging
 *        B5 extensions without before_agent_start handlers are skipped
 *        B6 per-handler throw routes to emitError, sibling handlers
 *           still run
 *        B7 setStatus/setWidget invoked exactly once per extension with
 *           handlers, with the correct key + extension short name in the text
 *        B8 setStatus/setWidget NOT invoked for extensions without handlers
 *        B9 NEW: emitError that throws is NOT caught (matches pi
 *           upstream, per review)
 *        B10 NEW: handler returns `{ message: null }` / falsy — NOT
 *           pushed to messages
 *        B11 NEW: handler returns `{ systemPrompt: "" }` — IS treated
 *           as mutation (`!== undefined` check)
 *        B12 NEW: handler returns only `message` (no systemPrompt) —
 *           return shape has `systemPrompt: undefined`
 *        B13 NEW: setStatus that throws does not abort the loop
 *        B17 NEW: setWidget that throws does not abort the loop
 *        B16 NEW: first before_agent_start label replaces Layer A's
 *           preflight stale timer with a long watchdog so slow Path A
 *           injection stays visible
 *
 *   C. Idempotent install + version-upgrade re-patch (NEW)
 *
 *   D. Missing-affordance early-return (NEW: degrades to no-op
 *      undefined, NOT delegating to original)
 *
 *   E. restoreEmitPatch (NEW): pristine method recovered, markers
 *      cleared, state.patched flag flipped
 *
 *   F. Layer A behaviour (NEW: fully covered)
 *        F1 input handler captures setStatus + setWidget + theme
 *        F2 input handler writes preparing… + pre-working widget and yields
 *        F3 agent_start clears the status + widget
 *        F4 agent_end clears the status + widget
 *        F5 sub-agent input is gated (does NOT overwrite main captures)
 *        F6 input event.source = "extension" is gated
 *        F7 stale-status timer fallback clears indicators after STALE_TIMEOUT_MS
 *        F8 PI_ASTACK_TURN_PROGRESS_NO_WIDGET disables only the widget
 *
 *   G. pi upstream drift sentinel (NEW): reads the real
 *      pi-coding-agent runner.js source and asserts the
 *      emitBeforeAgentStart body still contains the anchor tokens we
 *      mirror. A pi upgrade that changes those tokens fails this test
 *      loudly so the mirror is re-verified.
 *
 * Run: node scripts/smoke-turn-progress.mjs
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

// ── Transpile setup ─────────────────────────────────────────────────
//
// turn-progress/index.ts imports:
//   - @earendil-works/pi-coding-agent  (ESM-only; not require-able)
//   - ../_shared/footer-status         (TS)
//   - ../_shared/pi-internals          (TS, heavy — we only need
//                                       isSubAgentSession)
//
// We stub all three with minimal CJS files in the tmp dir.

const srcPath = path.join(repoRoot, "extensions/turn-progress/index.ts");
const sharedPath = path.join(repoRoot, "extensions/_shared/footer-status.ts");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-tp-"));

function transpileTs(filePath, outFile) {
  const code = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
  fs.writeFileSync(outFile, code);
}

const extDir = path.join(tmpDir, "extensions");
const sharedDir = path.join(extDir, "_shared");
const tpDir = path.join(extDir, "turn-progress");
fs.mkdirSync(sharedDir, { recursive: true });
fs.mkdirSync(tpDir, { recursive: true });

// Stub: @earendil-works/pi-coding-agent
const piStubPath = path.join(tpDir, "_pi-stub.cjs");
fs.writeFileSync(piStubPath, "exports.ExtensionRunner = class StubExtensionRunner {};\n");

// Stub: ../_shared/pi-internals — controllable isSubAgentSession.
// Tests flip the predicate by writing a flag on globalThis before
// invoking handlers, then resetting.
const internalsStubPath = path.join(sharedDir, "pi-internals.js");
fs.writeFileSync(
  internalsStubPath,
  [
    "const KEY = Symbol.for('pi-astack-smoke/sub-agent-mock');",
    "exports.isSubAgentSession = function (ctx) {",
    "  return globalThis[KEY] === true;",
    "};",
    "exports.__setSubAgentMock = function (value) { globalThis[KEY] = value; };",
    "",
  ].join("\n"),
);

// Rewrite the extension's imports to point to our stubs / transpiled files.
const srcCode = fs
  .readFileSync(srcPath, "utf8")
  .replace(/from\s+"@earendil-works\/pi-coding-agent"/g, 'from "./_pi-stub.cjs"')
  .replace(/from\s+"\.\.\/_shared\/footer-status"/g, 'from "../_shared/footer-status.js"')
  .replace(/from\s+"\.\.\/_shared\/pi-internals"/g, 'from "../_shared/pi-internals.js"');
const tpTmpSrc = path.join(tpDir, "index.ts");
fs.writeFileSync(tpTmpSrc, srcCode);

transpileTs(sharedPath, path.join(sharedDir, "footer-status.js"));
transpileTs(tpTmpSrc, path.join(tpDir, "index.js"));

let mod;
try {
  mod = require(path.join(tpDir, "index.js"));
} catch (err) {
  console.error(
    `smoke-turn-progress: failed to require transpiled module: ${err && err.stack ? err.stack : err}`,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}

const internalsMock = require(internalsStubPath);

const {
  extractShortName,
  yieldToEventLoop,
  PATCH_VERSION,
  PATCH_MARKER,
  ORIGINAL_MARKER,
  STATUS_KEY,
  WIDGET_KEY,
  STALE_TIMEOUT_MS,
  BEFORE_AGENT_START_WATCHDOG_MS,
  SPINNER_INTERVAL_MS,
  installEmitPatch,
  restoreEmitPatch,
  getState,
} = mod.__TEST;

// ── Test harness ─────────────────────────────────────────────────────

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

function resetState() {
  const st = getState();
  st.setStatus = undefined;
  st.setWidget = undefined;
  st.themeAccent = undefined;
  st.themeMuted = undefined;
  st.statusLabel = undefined;
  st.widgetLabel = undefined;
  st.spinnerFrameIndex = 0;
  st.patched = false;
  if (st.staleTimer !== undefined) {
    clearTimeout(st.staleTimer);
    st.staleTimer = undefined;
  }
  if (st.spinnerTimer !== undefined) {
    clearInterval(st.spinnerTimer);
    st.spinnerTimer = undefined;
  }
  st.warned.clear();
  internalsMock.__setSubAgentMock(false);
}

console.log("smoke: turn-progress");

// ── A. extractShortName ──────────────────────────────────────────────

check(
  "A. extractShortName: pi-astack layout (memory)",
  extractShortName("/home/u/.pi/agent/skills/pi-astack/extensions/memory/index.ts") === "memory",
);
check(
  "A. extractShortName: pi-astack layout (model-curator)",
  extractShortName("/home/u/.pi/agent/skills/pi-astack/extensions/model-curator/index.ts") ===
    "model-curator",
);
check(
  "A. extractShortName: Windows pi-astack layout (memory)",
  extractShortName("C:\\Users\\alfadb\\.pi\\agent\\skills\\pi-astack\\extensions\\memory\\index.ts") ===
    "memory",
);
check(
  "A. extractShortName: hypothetical nested (would be rule-injector)",
  extractShortName("/home/u/.pi/agent/skills/pi-astack/extensions/abrain/rule-injector/index.ts") ===
    "rule-injector",
);
check(
  "A. extractShortName: inline marker passed through",
  extractShortName("<inline:foo>") === "<inline:foo>",
);
check(
  "A. extractShortName: <inline> (no-colon form) passed through",
  extractShortName("<inline>") === "<inline>",
);
check(
  "A. extractShortName: bare file falls back to dirname basename",
  extractShortName("/tmp/x/y.ts") === "x",
);
check(
  "A. extractShortName: empty input handled gracefully",
  typeof extractShortName("") === "string",
);

// ── B. Mirror behaviour ──────────────────────────────────────────────

function makeRunner({ extensions, captureSetStatus = true, captureSetWidget = true, throwingSetStatus = false, throwingSetWidget = false }) {
  const errors = [];
  const setStatusCalls = [];
  const setWidgetCalls = [];
  const proto = {
    async emitBeforeAgentStart(prompt, images, systemPrompt, systemPromptOptions) {
      let currentSystemPrompt = systemPrompt;
      const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(this.createContext()));
      ctx.getSystemPrompt = () => {
        this.assertActive();
        return currentSystemPrompt;
      };
      const messages = [];
      let systemPromptModified = false;
      for (const ext of this.extensions) {
        const handlers = ext.handlers.get("before_agent_start");
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {
          try {
            const event = {
              type: "before_agent_start",
              prompt,
              images,
              systemPrompt: currentSystemPrompt,
              systemPromptOptions,
            };
            const handlerResult = await handler(event, ctx);
            if (handlerResult) {
              const result = handlerResult;
              if (result.message) messages.push(result.message);
              if (result.systemPrompt !== undefined) {
                currentSystemPrompt = result.systemPrompt;
                systemPromptModified = true;
              }
            }
          } catch (err) {
            this.emitError({
              extensionPath: ext.path,
              event: "before_agent_start",
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
          }
        }
      }
      if (messages.length > 0 || systemPromptModified) {
        return {
          messages: messages.length > 0 ? messages : undefined,
          systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
        };
      }
      return undefined;
    },
  };
  const instance = Object.create(proto);
  instance.extensions = extensions;
  instance.createContext = () => ({});
  instance.assertActive = () => {};
  instance.emitError = (info) => errors.push(info);

  const state = getState();
  if (captureSetStatus) {
    state.setStatus = (key, text) => {
      if (throwingSetStatus) throw new Error("setStatus boom");
      setStatusCalls.push({ key, text });
    };
  } else {
    state.setStatus = undefined;
  }
  if (captureSetWidget) {
    state.setWidget = (key, content, options) => {
      if (throwingSetWidget) throw new Error("setWidget boom");
      setWidgetCalls.push({ key, content, options });
    };
  } else {
    state.setWidget = undefined;
  }
  state.themeAccent = (s) => s;
  state.themeMuted = (s) => s;

  return { proto, instance, errors, setStatusCalls, setWidgetCalls };
}

async function runBaseline(extensions, systemPrompt = "BASE") {
  const { proto, instance, errors } = makeRunner({ extensions, captureSetStatus: false, captureSetWidget: false });
  const result = await proto.emitBeforeAgentStart.call(instance, "p", undefined, systemPrompt, undefined);
  return { result, errors };
}

async function runPatched(extensions, systemPrompt = "BASE", opts = {}) {
  const harness = makeRunner({ extensions, ...opts });
  installEmitPatch(harness.proto);
  const result = await harness.proto.emitBeforeAgentStart.call(harness.instance, "p", undefined, systemPrompt, undefined);
  return { result, errors: harness.errors, setStatusCalls: harness.setStatusCalls, setWidgetCalls: harness.setWidgetCalls };
}

// B1
{
  resetState();
  const exts = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => undefined]]]) },
    { path: "/e/extB/index.ts", handlers: new Map([["before_agent_start", [async () => undefined]]]) },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);
  check("B1. no mutation → undefined (baseline)", baseline.result === undefined);
  check("B1. no mutation → undefined (patched)", patched.result === undefined);
}

// B2 + B7 + B8
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([
        [
          "before_agent_start",
          [
            async (event) => ({
              systemPrompt: `${event.systemPrompt}\n[A1]`,
              message: { role: "custom", customType: "ann", content: "A1" },
            }),
            async (_event, ctx) => ({
              systemPrompt: `${ctx.getSystemPrompt()}\n[A2]`,
            }),
          ],
        ],
      ]),
    },
    {
      path: "/e/extB/index.ts",
      handlers: new Map([
        [
          "before_agent_start",
          [
            async (_event, ctx) => ({
              systemPrompt: `${ctx.getSystemPrompt()}\n[B1]`,
              message: { role: "custom", customType: "ann", content: "B1" },
            }),
          ],
        ],
      ]),
    },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);

  check(
    "B2. systemPrompt accumulates (baseline)",
    baseline.result?.systemPrompt === "BASE\n[A1]\n[A2]\n[B1]",
  );
  check(
    "B2. systemPrompt accumulates (patched matches baseline)",
    patched.result?.systemPrompt === baseline.result?.systemPrompt,
  );
  check(
    "B2. messages array matches (patched vs baseline)",
    JSON.stringify(patched.result?.messages) === JSON.stringify(baseline.result?.messages),
  );
  check(
    "B7. setStatus invoked once per ext-with-handlers + 1 terminal awaiting-model",
    patched.setStatusCalls.length === 3,
  );
  check(
    "B7. setStatus uses 00-turn-progress key",
    patched.setStatusCalls.every((c) => c.key === STATUS_KEY),
  );
  check(
    "B7. setStatus text contains extension short name",
    patched.setStatusCalls[0].text.includes("extA") &&
      patched.setStatusCalls[1].text.includes("extB"),
  );
  check(
    "B7. terminal call is honest 'awaiting model' (not a frozen ext name)",
    patched.setStatusCalls[2].text.includes("awaiting model") &&
      !patched.setStatusCalls[2].text.includes("extB"),
  );
  check(
    "B7. setWidget invoked once per ext-with-handlers + 1 terminal awaiting-model",
    patched.setWidgetCalls.length === 3,
  );
  check(
    "B7. setWidget uses pre-working widget key and aboveEditor placement",
    patched.setWidgetCalls.every((c) => c.key === WIDGET_KEY && c.options?.placement === "aboveEditor"),
  );
  check(
    "B7. widget content tracks extension names and terminal handoff",
    patched.setWidgetCalls[0].content?.[0]?.includes("Working") &&
      patched.setWidgetCalls[0].content?.[0]?.includes("extA") &&
      patched.setWidgetCalls[1].content?.[0]?.includes("extB") &&
      patched.setWidgetCalls[2].content?.[0]?.includes("awaiting model") &&
      !patched.setWidgetCalls[2].content?.[0]?.includes("extB"),
  );
}

// B5 + B8
{
  resetState();
  const exts = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "X" })]]]) },
    { path: "/e/extEmpty/index.ts", handlers: new Map() },
    { path: "/e/extB/index.ts", handlers: new Map([["before_agent_start", [async (e) => ({ systemPrompt: `${e.systemPrompt}|B` })]]]) },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);

  check("B5. ext without handlers skipped (baseline)", baseline.result?.systemPrompt === "X|B");
  check("B5. ext without handlers skipped (patched)", patched.result?.systemPrompt === baseline.result?.systemPrompt);
  check(
    "B8. setStatus NOT called for ext without handlers (2 ext + 1 terminal, none=extEmpty)",
    patched.setStatusCalls.length === 3 &&
      !patched.setStatusCalls.some((c) => c.text.includes("extEmpty")),
  );
  check(
    "B8. setWidget NOT called for ext without handlers (2 ext + 1 terminal, none=extEmpty)",
    patched.setWidgetCalls.length === 3 &&
      !patched.setWidgetCalls.some((c) => c.content?.[0]?.includes("extEmpty")),
  );
}

// B14 — zero handler-bearing extensions → terminal awaiting-model NOT called
// (the anyHandlerLabeled gate's false branch — Layer A's preparing… stands).
{
  resetState();
  const exts = [
    { path: "/e/x/index.ts", handlers: new Map() },
    { path: "/e/y/index.ts", handlers: new Map([["agent_end", [async () => {}]]]) },
  ];
  const patched = await runPatched(exts);
  check("B14. zero-handler chain → NO footer writes (terminal skipped)", patched.setStatusCalls.length === 0);
  check("B14. zero-handler chain → NO widget writes (terminal skipped)", patched.setWidgetCalls.length === 0);
  check("B14. zero-handler chain → result undefined (no mutations)", patched.result === undefined);
}

// B15 — sub-agent run: handlers STILL execute + mutate, but footer writes
// (per-ext labels AND the terminal awaiting-model) are gated off so a
// dispatch sub-agent never writes the MAIN session footer.
{
  resetState();
  internalsMock.__setSubAgentMock(true);
  const exts = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "X" })]]]) },
    { path: "/e/extB/index.ts", handlers: new Map([["before_agent_start", [async (e) => ({ systemPrompt: `${e.systemPrompt}|B` })]]]) },
  ];
  const patched = await runPatched(exts);
  internalsMock.__setSubAgentMock(false);
  check("B15. sub-agent: handlers still run (systemPrompt mutated)", patched.result?.systemPrompt === "X|B");
  check("B15. sub-agent: NO footer writes at all (per-ext + terminal gated)", patched.setStatusCalls.length === 0);
  check("B15. sub-agent: NO widget writes at all (per-ext + terminal gated)", patched.setWidgetCalls.length === 0);
}

// B6
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([
        [
          "before_agent_start",
          [
            async () => { throw new Error("boom from A"); },
            async () => ({ systemPrompt: "A-recovered" }),
          ],
        ],
      ]),
    },
    {
      path: "/e/extB/index.ts",
      handlers: new Map([["before_agent_start", [async (e) => ({ systemPrompt: `${e.systemPrompt}|B` })]]]),
    },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);

  check("B6. throw → emitError (baseline)", baseline.errors.length === 1 && baseline.errors[0].error === "boom from A");
  check("B6. throw → emitError (patched)", patched.errors.length === 1 && patched.errors[0].error === "boom from A");
  check("B6. sibling handler still runs (baseline)", baseline.result?.systemPrompt === "A-recovered|B");
  check("B6. sibling handler still runs (patched)", patched.result?.systemPrompt === baseline.result?.systemPrompt);
}

// B9 — emitError that throws is NOT caught (matches pi upstream)
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([
        ["before_agent_start", [
          async () => { throw new Error("handler boom"); },
        ]],
      ]),
    },
    {
      path: "/e/extB/index.ts",
      handlers: new Map([
        ["before_agent_start", [async () => ({ systemPrompt: "should-not-reach" })]],
      ]),
    },
  ];
  const harness = makeRunner({ extensions: exts });
  // Override emitError to throw.
  harness.instance.emitError = () => { throw new Error("emitError boom"); };
  installEmitPatch(harness.proto);
  let thrown;
  try {
    await harness.proto.emitBeforeAgentStart.call(harness.instance, "p", undefined, "BASE", undefined);
  } catch (err) {
    thrown = err;
  }
  check("B9. emitError throw propagates out of patched method", thrown !== undefined && thrown.message === "emitError boom");
}

// B10 — falsy message NOT pushed
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([
        ["before_agent_start", [
          async () => ({ message: null }),
          async () => ({ message: "" }),
          async () => ({ message: 0 }),
        ]],
      ]),
    },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);
  check("B10. falsy message NOT pushed (baseline)", baseline.result === undefined);
  check("B10. falsy message NOT pushed (patched)", patched.result === undefined);
}

// B11 — empty-string systemPrompt IS a mutation
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "" })]]]),
    },
  ];
  const baseline = await runBaseline(exts, "BASE");
  const patched = await runPatched(exts, "BASE");
  check(
    "B11. empty systemPrompt IS mutation (baseline)",
    baseline.result?.systemPrompt === "",
    `got: ${JSON.stringify(baseline.result)}`,
  );
  check(
    "B11. empty systemPrompt IS mutation (patched)",
    patched.result?.systemPrompt === "",
    `got: ${JSON.stringify(patched.result)}`,
  );
}

// B12 — message-only return has systemPrompt: undefined
{
  resetState();
  const exts = [
    {
      path: "/e/extA/index.ts",
      handlers: new Map([["before_agent_start", [async () => ({ message: { role: "custom", customType: "x", content: "y" } })]]]),
    },
  ];
  const baseline = await runBaseline(exts);
  const patched = await runPatched(exts);
  check("B12. message-only return shape (baseline)", baseline.result?.systemPrompt === undefined && Array.isArray(baseline.result?.messages));
  check("B12. message-only return shape (patched)", patched.result?.systemPrompt === undefined && Array.isArray(patched.result?.messages));
}

// B13 — throwing setStatus does not abort the loop
{
  resetState();
  const exts = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "A" })]]]) },
    { path: "/e/extB/index.ts", handlers: new Map([["before_agent_start", [async (e) => ({ systemPrompt: `${e.systemPrompt}|B` })]]]) },
  ];
  const patched = await runPatched(exts, "BASE", { throwingSetStatus: true });
  check(
    "B13. throwing setStatus does not abort loop",
    patched.result?.systemPrompt === "A|B",
    `got: ${JSON.stringify(patched.result)}`,
  );
}

// B17 — throwing setWidget does not abort the loop
{
  resetState();
  const exts = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "A" })]]]) },
    { path: "/e/extB/index.ts", handlers: new Map([["before_agent_start", [async (e) => ({ systemPrompt: `${e.systemPrompt}|B` })]]]) },
  ];
  const patched = await runPatched(exts, "BASE", { throwingSetWidget: true });
  check(
    "B17. throwing setWidget does not abort loop",
    patched.result?.systemPrompt === "A|B",
    `got: ${JSON.stringify(patched.result)}`,
  );
}

// B16 — entering before_agent_start replaces Layer A's preflight stale
// timer with the long watchdog. This locks the P0 fix for
// slow-but-healthy Path A memory injection: the footer must stay visible
// until agent_start/agent_end clears it.
{
  resetState();
  const st = getState();
  let shortTimerFired = false;
  st.staleTimer = setTimeout(() => { shortTimerFired = true; }, STALE_TIMEOUT_MS);
  const shortTimer = st.staleTimer;

  const exts = [
    { path: "/e/memory/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "MEM" })]]]) },
  ];
  const patched = await runPatched(exts);
  const longTimer = getState().staleTimer;

  check("B16. setup short timer exists before Layer B", shortTimer !== undefined);
  check("B16. entering first labeled handler replaced the short timer", longTimer !== undefined && longTimer !== shortTimer);
  check("B16. replacement did not clear footer during healthy before_agent_start", !patched.setStatusCalls.some((c) => c.text === undefined));
  check("B16. replacement did not clear widget during healthy before_agent_start", !patched.setWidgetCalls.some((c) => c.content === undefined));
  check("B16. BEFORE_AGENT_START_WATCHDOG_MS is longer than STALE_TIMEOUT_MS", BEFORE_AGENT_START_WATCHDOG_MS > STALE_TIMEOUT_MS);

  clearTimeout(shortTimer);
  if (longTimer !== undefined) clearTimeout(longTimer);
  getState().staleTimer = undefined;
  check("B16. old short timer did not fire synchronously", shortTimerFired === false);
}

// ── C. Idempotent install + version-upgrade re-patch ─────────────────

{
  resetState();
  const proto = { async emitBeforeAgentStart() { return undefined; } };
  const originalRef = proto.emitBeforeAgentStart;
  const first = installEmitPatch(proto);
  const refAfterFirst = proto.emitBeforeAgentStart;
  const second = installEmitPatch(proto);
  const refAfterSecond = proto.emitBeforeAgentStart;
  check("C. first install returns true", first === true);
  check("C. second install returns true (idempotent)", second === true);
  check("C. second install does not re-wrap (function ref unchanged)", refAfterFirst === refAfterSecond);
  check("C. PATCH_MARKER set on proto", proto[PATCH_MARKER] === PATCH_VERSION);
  check("C. ORIGINAL_MARKER preserved as pristine original", proto[ORIGINAL_MARKER] === originalRef);

  // Simulate a version upgrade: clear the PATCH_MARKER (mimic a future
  // module instance with bumped PATCH_VERSION) and re-install. The
  // ORIGINAL_MARKER guard should preserve the pristine reference, not
  // re-store the already-wrapped one.
  delete proto[PATCH_MARKER];
  const third = installEmitPatch(proto);
  check("C. version-upgrade re-patch succeeds", third === true);
  check(
    "C. ORIGINAL_MARKER still points to pristine pre-patch fn (not wrapped)",
    proto[ORIGINAL_MARKER] === originalRef,
  );
  // The re-installed wrapper IS a new function (we don't dedup beyond
  // PATCH_MARKER), but calling it should still delegate to the pristine
  // original on missing-affordance path.
  const stubInstance = { extensions: [] }; // no createContext / emitError
  const res = await proto.emitBeforeAgentStart.call(stubInstance, "p", undefined, "BASE", undefined);
  check("C. version-upgrade re-patch: missing affordances → undefined", res === undefined);
}

// ── D. Missing affordances → no-op undefined (not delegating to original) ──

{
  resetState();
  const proto = { async emitBeforeAgentStart() { return { systemPrompt: "ORIGINAL_RAN" }; } };
  installEmitPatch(proto);
  const instance = Object.create(proto);
  instance.extensions = [
    { path: "/e/extA/index.ts", handlers: new Map([["before_agent_start", [async () => ({ systemPrompt: "X" })]]]) },
  ];
  // No createContext, no emitError.
  const result = await proto.emitBeforeAgentStart.call(instance, "p", undefined, "BASE", undefined);
  check(
    "D. missing affordances → undefined (no-op, NOT delegating to original)",
    result === undefined,
    `got: ${JSON.stringify(result)}`,
  );
}

// ── E. restoreEmitPatch ──────────────────────────────────────────────

{
  resetState();
  const proto = { async emitBeforeAgentStart() { return { systemPrompt: "ORIGINAL" }; } };
  const originalRef = proto.emitBeforeAgentStart;

  // Restore on un-patched proto → false
  check("E. restore on un-patched proto returns false", restoreEmitPatch(proto) === false);

  // Install, then restore.
  installEmitPatch(proto);
  check("E. install set PATCH_MARKER", proto[PATCH_MARKER] === PATCH_VERSION);
  const restored = restoreEmitPatch(proto);
  check("E. restore on patched proto returns true", restored === true);
  check("E. restore reinstates pristine emitBeforeAgentStart", proto.emitBeforeAgentStart === originalRef);
  check("E. restore clears PATCH_MARKER", proto[PATCH_MARKER] === undefined);
  check("E. restore clears ORIGINAL_MARKER", proto[ORIGINAL_MARKER] === undefined);
  check("E. restore resets state.patched", getState().patched === false);

  // Pristine still works after restore.
  const stubInstance = {};
  const res = await proto.emitBeforeAgentStart.call(stubInstance, "p", undefined, "BASE", undefined);
  check("E. pristine method still functional after restore", res?.systemPrompt === "ORIGINAL");
}

// ── F. Layer A behaviour ─────────────────────────────────────────────
//
// Layer A is the input/agent_start/agent_end pi event handlers. The
// extension's default export is the activate function; we call it with
// a fake pi API that captures handler registrations, then drive the
// handlers directly with synthetic events.
//
// Suppress console.warn during F: the stub ExtensionRunner has no
// emitBeforeAgentStart, so each mod.default(fakePi) call legitimately
// warns once. That warning IS expected behaviour (production sees it
// too on a future pi upgrade that removes the method); we silence it
// here to keep the smoke output readable. We restore at the end.
const originalConsoleWarn = console.warn;
let suppressedWarnings = 0;
console.warn = (msg) => {
  if (typeof msg === "string" && msg.startsWith("pi-astack/turn-progress:")) {
    suppressedWarnings++;
    return;
  }
  originalConsoleWarn(msg);
};

function makeFakePi() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    emit(event, ev, ctx) {
      const list = handlers.get(event) ?? [];
      return Promise.all(list.map((h) => h(ev, ctx)));
    },
    getHandlers(event) {
      return handlers.get(event) ?? [];
    },
  };
}

function makeFakeCtx({ subAgent = false, withUi = true, themed = true, withWidget = true } = {}) {
  const setStatusCalls = [];
  const setWidgetCalls = [];
  const ui = withUi
    ? {
        setStatus: function (key, text) {
          // method form (not arrow) so .bind matters
          setStatusCalls.push({ key, text, boundThis: this === ui });
        },
        ...(withWidget
          ? {
              setWidget: function (key, content, options) {
                // method form (not arrow) so .bind matters
                setWidgetCalls.push({ key, content, options, boundThis: this === ui });
              },
            }
          : {}),
        theme: themed
          ? {
              fg: function (color, text) {
                // method form
                return `[${color}]${text}`;
              },
            }
          : undefined,
      }
    : undefined;
  const ctx = {
    sessionManager: subAgent ? { __mockSubAgent: true } : { __mockMain: true },
    ui,
  };
  return { ctx, setStatusCalls, setWidgetCalls };
}

// F1 + F2
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);
  const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();
  await fakePi.emit("input", { type: "input", source: "interactive" }, ctx);

  check("F1/F2. input handler captured setStatus into state", typeof getState().setStatus === "function");
  check("F1/F2. input handler captured setWidget into state", typeof getState().setWidget === "function");
  check("F1. input handler captured theme.fg into state.themeAccent", typeof getState().themeAccent === "function");
  check("F2. input handler wrote preparing… to status", setStatusCalls.length >= 1 && setStatusCalls[0].key === STATUS_KEY);
  check("F2. preparing… text uses native spinner frame and theme colours", setStatusCalls[0].text.includes("[accent]⠋") && setStatusCalls[0].text.includes("[muted]preparing") && !setStatusCalls[0].text.includes("⏳"));
  check("F2. setStatus called with correct `this` (bound to ui)", setStatusCalls[0].boundThis === true);
  check("F2. input handler wrote pre-working widget", setWidgetCalls.length >= 1 && setWidgetCalls[0].key === WIDGET_KEY);
  check("F2. widget uses aboveEditor placement", setWidgetCalls[0].options?.placement === "aboveEditor");
  check("F2. widget text uses native spinner frame and preparing label", setWidgetCalls[0].content?.[0]?.includes("[accent]⠋") && setWidgetCalls[0].content?.[0]?.includes("[muted]Working") && setWidgetCalls[0].content?.[0]?.includes("preparing turn") && !setWidgetCalls[0].content?.[0]?.includes("⏳"));
  check("F2. setWidget called with correct `this` (bound to ui)", setWidgetCalls[0].boundThis === true);
}

// F3 — agent_start clears
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);
  const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();
  await fakePi.emit("input", { type: "input", source: "interactive" }, ctx);
  await fakePi.emit("agent_start", { type: "agent_start" }, ctx);

  // Find the clear calls (text/content === undefined).
  const clearCalls = setStatusCalls.filter((c) => c.text === undefined && c.key === STATUS_KEY);
  const widgetClearCalls = setWidgetCalls.filter((c) => c.content === undefined && c.key === WIDGET_KEY);
  check("F3. agent_start cleared the status (called setStatus with undefined)", clearCalls.length === 1);
  check("F3. agent_start cleared the widget (called setWidget with undefined)", widgetClearCalls.length === 1);
}

// F4 — agent_end clears
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);
  const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();
  await fakePi.emit("input", { type: "input", source: "interactive" }, ctx);
  await fakePi.emit("agent_end", { type: "agent_end" }, ctx);

  const clearCalls = setStatusCalls.filter((c) => c.text === undefined && c.key === STATUS_KEY);
  const widgetClearCalls = setWidgetCalls.filter((c) => c.content === undefined && c.key === WIDGET_KEY);
  check("F4. agent_end cleared the status", clearCalls.length === 1);
  check("F4. agent_end cleared the widget", widgetClearCalls.length === 1);
}

// F5 — sub-agent input is gated
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);

  // First a normal main-session input captures setStatus.
  const main = makeFakeCtx({ subAgent: false });
  await fakePi.emit("input", { type: "input", source: "interactive" }, main.ctx);
  const mainCapturedRef = getState().setStatus;
  const mainCapturedWidgetRef = getState().setWidget;
  check("F5. main-session input captured setStatus", typeof mainCapturedRef === "function");
  check("F5. main-session input captured setWidget", typeof mainCapturedWidgetRef === "function");

  // Then a sub-agent input arrives.
  internalsMock.__setSubAgentMock(true);
  const sub = makeFakeCtx({ subAgent: true });
  await fakePi.emit("input", { type: "input", source: "interactive" }, sub.ctx);
  internalsMock.__setSubAgentMock(false);

  check(
    "F5. sub-agent input did NOT overwrite captured setStatus",
    getState().setStatus === mainCapturedRef,
  );
  check(
    "F5. sub-agent input did NOT overwrite captured setWidget",
    getState().setWidget === mainCapturedWidgetRef,
  );
  check(
    "F5. sub-agent input did NOT call its own ui.setStatus",
    sub.setStatusCalls.length === 0,
  );
  check(
    "F5. sub-agent input did NOT call its own ui.setWidget",
    sub.setWidgetCalls.length === 0,
  );
}

// F6 — input event.source = "extension" is gated
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);
  const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();
  await fakePi.emit("input", { type: "input", source: "extension" }, ctx);
  check("F6. source=extension does NOT set status", setStatusCalls.length === 0);
  check("F6. source=extension does NOT set widget", setWidgetCalls.length === 0);
  check("F6. source=extension does NOT capture setStatus", getState().setStatus === undefined);
  check("F6. source=extension does NOT capture setWidget", getState().setWidget === undefined);

  // Confirm that source=undefined (legacy event shape) still works.
  await fakePi.emit("input", { type: "input" }, ctx);
  check("F6. source=undefined falls through for status (legacy compat)", setStatusCalls.length === 1);
  check("F6. source=undefined falls through for widget (legacy compat)", setWidgetCalls.length === 1);
}

// F7 — stale-status fallback fires
{
  resetState();
  const fakePi = makeFakePi();
  mod.default(fakePi);
  const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let capturedTimerCallback;
  let capturedTimerDelay;
  let clearTimeoutCalls = 0;
  const fakeTimerHandle = { unrefCalled: false, unref() { this.unrefCalled = true; } };

  globalThis.setTimeout = ((cb, delay) => {
    capturedTimerCallback = cb;
    capturedTimerDelay = delay;
    return fakeTimerHandle;
  });
  globalThis.clearTimeout = ((handle) => {
    if (handle === fakeTimerHandle) clearTimeoutCalls++;
  });
  try {
    await fakePi.emit("input", { type: "input", source: "interactive" }, ctx);
    check("F7. setup: timer was scheduled", getState().staleTimer === fakeTimerHandle);
    check("F7. stale timer uses configured 120s preflight timeout", capturedTimerDelay === 120_000 && STALE_TIMEOUT_MS === 120_000);
    check("F7. stale timer handle was unref'ed", fakeTimerHandle.unrefCalled === true);

    capturedTimerCallback();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  const clearCalls = setStatusCalls.filter((c) => c.text === undefined && c.key === STATUS_KEY);
  const widgetClearCalls = setWidgetCalls.filter((c) => c.content === undefined && c.key === WIDGET_KEY);
  check("F7. real stale-timer callback clears state.staleTimer", getState().staleTimer === undefined);
  check("F7. real stale-timer callback clears the status", clearCalls.length === 1);
  check("F7. real stale-timer callback clears the widget", widgetClearCalls.length === 1);
  check("F7. timer callback did not call clearTimeout on itself", clearTimeoutCalls === 0);
  check("F7. before_agent_start watchdog is a sane positive number", typeof BEFORE_AGENT_START_WATCHDOG_MS === "number" && BEFORE_AGENT_START_WATCHDOG_MS > STALE_TIMEOUT_MS);
}

// F8 — widget opt-out disables only the pre-working widget.
{
  resetState();
  const fakePi = makeFakePi();
  const oldEnv = process.env.PI_ASTACK_TURN_PROGRESS_NO_WIDGET;
  process.env.PI_ASTACK_TURN_PROGRESS_NO_WIDGET = "1";
  try {
    mod.default(fakePi);
    const { ctx, setStatusCalls, setWidgetCalls } = makeFakeCtx();
    await fakePi.emit("input", { type: "input", source: "interactive" }, ctx);
    check("F8. NO_WIDGET still captures/writes status", typeof getState().setStatus === "function" && setStatusCalls.length >= 1);
    check("F8. NO_WIDGET does not capture setWidget", getState().setWidget === undefined);
    check("F8. NO_WIDGET does not write widget", setWidgetCalls.length === 0);
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_ASTACK_TURN_PROGRESS_NO_WIDGET;
    } else {
      process.env.PI_ASTACK_TURN_PROGRESS_NO_WIDGET = oldEnv;
    }
  }
}

// ── G. pi upstream drift sentinel ───────────────────────────────────
//
// Read the real pi runner.js and assert it still contains the anchor
// tokens our mirror depends on. A pi upgrade that changes any of these
// causes a loud smoke failure so the mirror is re-verified BEFORE the
// drift hits users.

{
  // Locate the installed pi runner.js — we look at the agent's known
  // install paths. If pi isn't installed at the expected location,
  // skip with a warning (smoke runs in CI without pi available).
  const candidates = [
    "/home/worker/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
    path.join(repoRoot, "../../../../.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js"),
  ];
  let runnerSrc;
  for (const candidate of candidates) {
    try {
      runnerSrc = fs.readFileSync(candidate, "utf8");
      break;
    } catch {
      // try next
    }
  }

  if (!runnerSrc) {
    console.log("  skip  G. pi upstream drift sentinel (pi not installed at known path)");
  } else {
    // The mirror depends on these specific tokens in emitBeforeAgentStart.
    // Each anchor maps to a behavioural assumption documented in the
    // installEmitPatch mirror block.
    const anchors = [
      {
        name: "emitBeforeAgentStart method declaration",
        re: /async\s+emitBeforeAgentStart\s*\(\s*prompt\s*,\s*images\s*,\s*systemPrompt\s*,\s*systemPromptOptions\s*\)/,
      },
      {
        name: "currentSystemPrompt initialised from systemPrompt arg",
        re: /let\s+currentSystemPrompt\s*=\s*systemPrompt\s*;/,
      },
      {
        name: "ctx built via Object.defineProperties + getOwnPropertyDescriptors(createContext)",
        re: /Object\.defineProperties\s*\(\s*\{\s*\}\s*,\s*Object\.getOwnPropertyDescriptors\s*\(\s*this\.createContext\(\)\s*\)\s*\)/,
      },
      {
        name: "ctx.getSystemPrompt closure that calls assertActive",
        re: /ctx\.getSystemPrompt\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}this\.assertActive\(\)\s*;[\s\S]{0,200}return\s+currentSystemPrompt\s*;[\s\S]{0,30}\}\s*;/,
      },
      {
        name: "per-extension loop reading handlers.get('before_agent_start')",
        re: /for\s*\(\s*const\s+ext\s+of\s+this\.extensions\s*\)\s*\{[\s\S]{0,400}ext\.handlers\.get\(\s*"before_agent_start"\s*\)/,
      },
      {
        name: "emitError call with extensionPath/event/error/stack fields",
        re: /this\.emitError\s*\(\s*\{[\s\S]{0,200}extensionPath\s*:[\s\S]{0,200}event\s*:[\s\S]{0,200}error\s*:[\s\S]{0,200}stack\s*:/,
      },
      {
        name: "return shape: {messages, systemPrompt} OR undefined",
        re: /messages\s*:\s*messages\.length\s*>\s*0\s*\?\s*messages\s*:\s*undefined[\s\S]{0,200}systemPrompt\s*:\s*systemPromptModified\s*\?\s*currentSystemPrompt\s*:\s*undefined/,
      },
    ];

    for (const a of anchors) {
      check(`G. pi upstream anchor present: ${a.name}`, a.re.test(runnerSrc));
    }
  }
}

// Restore console.warn and report.
console.warn = originalConsoleWarn;
if (suppressedWarnings > 0) {
  console.log(`  (suppressed ${suppressedWarnings} expected pi-astack/turn-progress warnings during F)`);
}

console.log(`\nfailures: ${failures}`);

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // best-effort
}

process.exit(failures === 0 ? 0 : 1);
