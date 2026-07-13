#!/usr/bin/env node
/**
 * Smoke test: compaction-tuner INV-K defer hook (ADR 0022 P3a).
 *
 * The defer decision is encapsulated in
 * `extensions/compaction-tuner/prompt-user-defer.ts` — a deliberately
 * leaf module with NO cross-extension imports so it can be smoke-tested
 * in isolation. Verifies all branches of `isPendingPromptUserBlocking`
 * + an integration assertion against the real
 * `prompt-user/manager.getPendingPromptCount`.
 *
 * Invariants:
 *
 *   ADR 0022 INV-K — compaction-tuner skips compaction when pending
 *     prompt > 0. The trigger path in compaction-tuner/index.ts calls
 *     this helper; if it returns true, the path early-returns BEFORE
 *     consuming rearm state, so the next agent_end re-classifies.
 *
 *   Defense-in-depth — hook throwing / returning non-number / negative
 *     never blocks compaction. User-visible compaction failures are
 *     worse than missing a single INV-K defer (which the next turn
 *     will catch up on).
 *
 *   Wiring — abrain/index.ts activate() publishes the hook on
 *     globalThis; the integration assertion proves the wire works
 *     end-to-end (without mocking the pi extension lifecycle).
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-compaction-defer-"));

// Only one file. Pure helper, no transitive deps.
fs.writeFileSync(
  path.join(tmpDir, "prompt-user-defer.cjs"),
  transpile(path.join(repoRoot, "extensions/compaction-tuner/prompt-user-defer.ts")),
);

console.log(`Smoke: compaction-tuner INV-K defer (ADR 0022 P3a)`);
console.log(`tmpDir=${tmpDir}\n`);

const { isPendingPromptUserBlocking } = require(path.join(tmpDir, "prompt-user-defer.cjs"));

if (typeof isPendingPromptUserBlocking !== "function") {
  console.log("FAIL: isPendingPromptUserBlocking is not a function");
  process.exit(1);
}

// Snapshot + restore globalThis hook state across tests.
function withHook(value, fn) {
  const key = "__abrainPromptUserGetPending";
  const prev = globalThis[key];
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete globalThis[key];
    else globalThis[key] = prev;
  }
}

// ── 1. Hook missing → false (compaction proceeds normally) ────────

check("hook absent → false (abrain not loaded; compaction proceeds)", () => {
  withHook(undefined, () => {
    if (isPendingPromptUserBlocking() !== false) throw new Error("expected false");
  });
});

// ── 2. Hook returns 0 → false ─────────────────────────────────────

check("hook returns 0 → false (no pending; compaction proceeds)", () => {
  withHook(() => 0, () => {
    if (isPendingPromptUserBlocking() !== false) throw new Error("expected false");
  });
});

// ── 3. Hook returns N > 0 → true (defer compaction) ───────────────

check("hook returns 1 → true (one pending; INV-K defer)", () => {
  withHook(() => 1, () => {
    if (isPendingPromptUserBlocking() !== true) throw new Error("expected true");
  });
});

check("hook returns large N → true", () => {
  withHook(() => 42, () => {
    if (isPendingPromptUserBlocking() !== true) throw new Error("expected true");
  });
});

// ── 4. Defense-in-depth: hook throws → false ─────────────────────

check("hook throws → false (compaction failures > missed INV-K defer)", () => {
  withHook(() => { throw new Error("intentional hook failure"); }, () => {
    if (isPendingPromptUserBlocking() !== false) throw new Error("expected false");
  });
});

// ── 5. Type robustness ────────────────────────────────────────────

check("hook returns non-number ('1') → false (strict type check)", () => {
  withHook(() => "1", () => {
    if (isPendingPromptUserBlocking() !== false) {
      throw new Error("string was treated as truthy");
    }
  });
});

check("hook returns null → false", () => {
  withHook(() => null, () => {
    if (isPendingPromptUserBlocking() !== false) throw new Error("null was treated as truthy");
  });
});

check("hook returns negative number → false (corruption guard)", () => {
  withHook(() => -5, () => {
    if (isPendingPromptUserBlocking() !== false) {
      throw new Error("negative was treated as pending");
    }
  });
});

check("hook returns NaN → false", () => {
  withHook(() => NaN, () => {
    if (isPendingPromptUserBlocking() !== false) throw new Error("NaN treated as pending");
  });
});

// ── 6. End-to-end: real manager publishes the hook ────────────────
//
// Ties P2's hook publication (abrain activate) to P3a's hook
// consumption (compaction-tuner defer). We stage prompt-user/manager.cjs
// into a tmpDir, then simulate the abrain activate() side by publishing
// the hook ourselves (pi extension lifecycle isn't available in smoke).

check("real manager.getPendingPromptCount integrates with the helper", () => {
  const muDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-mgr-"));
  fs.mkdirSync(path.join(muDir, "prompt-user"), { recursive: true });
  fs.writeFileSync(
    path.join(muDir, "redact.cjs"),
    transpile(path.join(repoRoot, "extensions/abrain/redact.ts")),
  );
  fs.writeFileSync(
    path.join(muDir, "redact.js"),
    `module.exports = require("./redact.cjs");\n`,
  );
  for (const m of ["types", "manager"]) {
    const cjs = path.join(muDir, "prompt-user", `${m}.cjs`);
    fs.writeFileSync(cjs, transpile(path.join(repoRoot, "extensions/abrain/prompt-user", `${m}.ts`)));
    fs.copyFileSync(cjs, path.join(muDir, "prompt-user", `${m}.js`));
  }
  const manager = require(path.join(muDir, "prompt-user", "manager"));
  manager.__resetForTests();
  // Publish the hook the way abrain activate() does.
  globalThis.__abrainPromptUserGetPending = () => manager.getPendingPromptCount();
  try {
    if (isPendingPromptUserBlocking() !== false) {
      throw new Error("with 0 pending, helper should be false");
    }
    const handle = manager.acquirePending({});
    if (isPendingPromptUserBlocking() !== true) {
      throw new Error("with 1 pending, helper should be true");
    }
    // Two concurrent (INV-I will reject the LLM path, but at the
    // manager level you CAN have 2 pending via different callers).
    const handle2 = manager.acquirePending({});
    if (isPendingPromptUserBlocking() !== true) {
      throw new Error("with 2 pending, helper still true");
    }
    manager.cancelAllPending("cancelled");
    if (isPendingPromptUserBlocking() !== false) {
      throw new Error("after cancelAllPending, helper should be false");
    }
    // drain promises (paranoia)
    void handle.promise;
    void handle2.promise;
  } finally {
    delete globalThis.__abrainPromptUserGetPending;
    try { fs.rmSync(muDir, { recursive: true, force: true }); } catch {}
  }
});

// ── Summary ───────────────────────────────────────────────────────

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
