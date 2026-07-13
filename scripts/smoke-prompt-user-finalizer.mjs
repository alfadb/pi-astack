#!/usr/bin/env node
/**
 * Smoke test: prompt_user lifecycle finalizers (ADR 0022 P2).
 *
 * Verifies explicit prompt termination + INV-K (compaction defer):
 *
 *   1. `ctx.signal` abort           → resolves with `cancelled`
 *   2. `cancelAllPending(reason)`   → resolves with the given reason
 *   3. no terminal event            → remains pending indefinitely
 *
 * Plus:
 *   - acquirePending exposes a resolve callback that is idempotent
 *     (double-call no-ops)
 *   - pending Map drains to 0 after each terminal resolution
 *   - disposers fire exactly once on terminal resolution
 *   - acquirePending returns a usable AbortSignal for the dialog
 *   - resolveOnce on already-settled handle is a no-op (no double-resolve)
 *   - INV-K: __abrainPromptUserGetPending hook reflects pending count
 *     (will exist after abrain activate; smoke ignores absence)
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-prompt-user-fin-"));
fs.mkdirSync(path.join(tmpDir, "prompt-user"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "redact.cjs"), transpile(path.join(repoRoot, "extensions/abrain/redact.ts")));
fs.writeFileSync(path.join(tmpDir, "redact.js"), `module.exports = require("./redact.cjs");\n`);
for (const m of ["types", "manager"]) {
  const cjs = path.join(tmpDir, "prompt-user", `${m}.cjs`);
  fs.writeFileSync(cjs, transpile(path.join(repoRoot, "extensions/abrain/prompt-user", `${m}.ts`)));
  fs.copyFileSync(cjs, path.join(tmpDir, "prompt-user", `${m}.js`));
}

const manager = require(path.join(tmpDir, "prompt-user", "manager"));

console.log(`Smoke: prompt_user finalizer + lifecycle (ADR 0022 P2)`);
console.log(`tmpDir=${tmpDir}\n`);

// ── 1. No automatic timeout ───────────────────────────────────────

await asyncCheck("no terminal event: prompt remains pending until explicit cancel", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending();
  if (manager.getPendingPromptCount() !== 1) {
    throw new Error(`expected 1 pending, got ${manager.getPendingPromptCount()}`);
  }
  const observed = await Promise.race([
    handle.promise.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 80)),
  ]);
  if (observed !== "pending") throw new Error("prompt settled without a terminal event");
  if (manager.getPendingPromptCount() !== 1) throw new Error("pending entry drained itself");
  manager.cancelAllPending("cancelled");
  const result = await handle.promise;
  if (result.ok || result.reason !== "cancelled") {
    throw new Error(`explicit cancel result=${JSON.stringify(result)}`);
  }
  if (manager.getPendingPromptCount() !== 0) {
    throw new Error(`pending should drain to 0, got ${manager.getPendingPromptCount()}`);
  }
});

// ── 2. upstream signal abort → cancelled ──────────────────────────

await asyncCheck("INV-B: ctx.signal abort → ok:false, reason:'cancelled'", async () => {
  manager.__resetForTests();
  const ac = new AbortController();
  const handle = manager.acquirePending({ upstreamSignal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const result = await handle.promise;
  if (result.reason !== "cancelled") throw new Error(`reason=${result.reason}`);
  if (manager.getPendingPromptCount() !== 0) throw new Error("pending not drained");
});

await asyncCheck("INV-B: pre-aborted signal still resolves (microtask path)", async () => {
  manager.__resetForTests();
  const ac = new AbortController();
  ac.abort();
  const handle = manager.acquirePending({ upstreamSignal: ac.signal });
  // Must still observe an awaitable promise first — the resolution is
  // posted via queueMicrotask, NOT synchronous.
  const result = await handle.promise;
  if (result.reason !== "cancelled") throw new Error(`reason=${result.reason}`);
});

// ── 3. cancelAllPending ───────────────────────────────────────────

await asyncCheck("INV-B: cancelAllPending('cancelled') drains pending Map", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending({});
  if (manager.getPendingPromptCount() !== 1) throw new Error("setup failed");
  const cancelled = manager.cancelAllPending("cancelled");
  if (cancelled !== 1) throw new Error(`cancelAllPending returned ${cancelled}`);
  const result = await handle.promise;
  if (result.reason !== "cancelled") throw new Error(`reason=${result.reason}`);
  if (manager.getPendingPromptCount() !== 0) throw new Error("pending not drained");
});

await asyncCheck("INV-B: cancelAllPending on empty Map → 0, no throw", async () => {
  manager.__resetForTests();
  const n = manager.cancelAllPending("cancelled");
  if (n !== 0) throw new Error(`got ${n}`);
});

// ── 4. Idempotency: resolve twice / cancel after resolve ──────────

await asyncCheck("resolveOnce is idempotent (double-call is no-op)", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending({});
  handle.resolve({ ok: true, answers: { x: ["1"] }, durationMs: 5 });
  // Second resolve attempt with different shape — should NOT change
  // the awaited result.
  handle.resolve({ ok: false, reason: "cancelled", durationMs: 999 });
  const result = await handle.promise;
  if (!result.ok) throw new Error("idempotency broke; second resolve overrode first");
  if (result.durationMs !== 5) throw new Error(`durationMs=${result.durationMs}`);
});

await asyncCheck("cancelAllPending after resolve is a no-op", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending({});
  handle.resolve({ ok: true, answers: {}, durationMs: 0 });
  await handle.promise;
  const n = manager.cancelAllPending("cancelled");
  if (n !== 0) throw new Error(`expected 0 (already drained), got ${n}`);
});

// ── 5. Disposer plumbing ──────────────────────────────────────────

await asyncCheck("registerDisposer fires once on terminal resolution", async () => {
  manager.__resetForTests();
  let fired = 0;
  const handle = manager.acquirePending({});
  handle.registerDisposer(() => { fired += 1; });
  handle.resolve({ ok: true, answers: {}, durationMs: 0 });
  await handle.promise;
  // Wait an event-loop tick to let any pending disposer dispatches finish.
  await new Promise((r) => setImmediate(r));
  if (fired !== 1) throw new Error(`disposer fired ${fired} times`);
});

await asyncCheck("registerDisposer AFTER resolve runs inline immediately", async () => {
  manager.__resetForTests();
  let fired = 0;
  const handle = manager.acquirePending({});
  handle.resolve({ ok: true, answers: {}, durationMs: 0 });
  await handle.promise;
  handle.registerDisposer(() => { fired += 1; });
  if (fired !== 1) throw new Error(`late disposer not fired inline (fired=${fired})`);
});

await asyncCheck("disposer throw does not strand pending Map", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending({});
  handle.registerDisposer(() => { throw new Error("boom"); });
  handle.resolve({ ok: true, answers: {}, durationMs: 0 });
  await handle.promise;
  if (manager.getPendingPromptCount() !== 0) {
    throw new Error("pending leaked after throwing disposer");
  }
});

// ── 6. snapshotPending diagnostics ────────────────────────────────

await asyncCheck("snapshotPending returns shape {id, ageMs}", async () => {
  manager.__resetForTests();
  const handle = manager.acquirePending();
  const snap = manager.snapshotPending();
  if (snap.length !== 1) throw new Error(`length=${snap.length}`);
  const entry = snap[0];
  if (!entry.id?.startsWith("pu_")) throw new Error(`id=${entry.id}`);
  if (typeof entry.ageMs !== "number") throw new Error("ageMs not number");
  if ("timeoutSec" in entry) throw new Error("timeoutSec leaked into diagnostics");
  handle.resolve({ ok: false, reason: "cancelled", durationMs: 0 });
  await handle.promise;
});

// ── 7. getPendingPromptCount monotonically tracks Map ─────────────

await asyncCheck("getPendingPromptCount tracks Map size deterministically", async () => {
  manager.__resetForTests();
  if (manager.getPendingPromptCount() !== 0) throw new Error("non-zero at start");
  const h1 = manager.acquirePending({});
  if (manager.getPendingPromptCount() !== 1) throw new Error("expected 1 after first");
  const h2 = manager.acquirePending({});
  if (manager.getPendingPromptCount() !== 2) throw new Error("expected 2 after second");
  h1.resolve({ ok: false, reason: "cancelled", durationMs: 0 });
  await h1.promise;
  if (manager.getPendingPromptCount() !== 1) {
    throw new Error(`expected 1 after first drain, got ${manager.getPendingPromptCount()}`);
  }
  manager.cancelAllPending("cancelled");
  await h2.promise;
  if (manager.getPendingPromptCount() !== 0) throw new Error("should be 0");
});

// ── Summary ──────────────────────────────────────────────────────

console.log("");
console.log(`Total: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  - ${name}\n    ${err.stack || err.message}`);
  }
  process.exit(1);
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(0);
