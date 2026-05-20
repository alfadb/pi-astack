#!/usr/bin/env node
/**
 * Smoke test: compaction-tuner INV-K defer hook for vault dialog
 * (ADR 0022 §D11 / Batch B D7, 2026-05-20).
 *
 * Mirrors `smoke-compaction-tuner-prompt-user.mjs` but exercises the
 * vault-dialog branch. The defer decision lives in
 * `extensions/compaction-tuner/vault-defer.ts` — deliberately a leaf
 * module so it can be smoke-tested in isolation. Verifies every branch
 * of `isPendingVaultDialogBlocking` + an integration assertion against
 * the real `vault-authorize.__vaultDialogInFlight` flag.
 *
 * Invariants:
 *
 *   ADR 0022 INV-K (extended) — compaction-tuner skips compaction when
 *     a vault authorization overlay is in flight. The trigger path in
 *     compaction-tuner/index.ts calls this helper; if it returns true,
 *     the path early-returns BEFORE consuming rearm state, so the next
 *     agent_end re-classifies.
 *
 *   Defense-in-depth — hook throwing / returning non-bool never blocks
 *     compaction. User-visible compaction failures are worse than
 *     missing a single INV-K defer (which the next turn will catch up
 *     on).
 *
 *   Symmetry — same shape as prompt-user-defer.ts but separate hook
 *     name and separate audit reason. See vault-defer.ts header for
 *     why these are NOT collapsed into one "any overlay" flag.
 *
 *   Wiring — abrain/index.ts activate() publishes the hook on
 *     globalThis as `__abrainVaultDialogInFlight` with
 *     `defineProperty configurable:false writable:false`. The
 *     integration assertion proves the wire works end-to-end against
 *     the real `vault-authorize.isVaultDialogInFlight()` getter.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-compaction-vault-defer-"));

// Only one file under test for the unit-level checks. Pure helper, no
// transitive deps.
fs.writeFileSync(
  path.join(tmpDir, "vault-defer.cjs"),
  transpile(path.join(repoRoot, "extensions/compaction-tuner/vault-defer.ts")),
);

console.log(`Smoke: compaction-tuner INV-K defer for vault dialog (ADR 0022 §D11 / Batch B D7)`);
console.log(`tmpDir=${tmpDir}\n`);

const { isPendingVaultDialogBlocking } = require(path.join(tmpDir, "vault-defer.cjs"));

if (typeof isPendingVaultDialogBlocking !== "function") {
  console.log("FAIL: isPendingVaultDialogBlocking is not a function");
  process.exit(1);
}

// Snapshot + restore globalThis hook state across tests. Uses
// defineProperty to allow the "non-configurable" smoke case to mirror
// production abrain/index.ts hardening.
function withHook(value, fn) {
  const key = "__abrainVaultDialogInFlight";
  const prev = Object.getOwnPropertyDescriptor(globalThis, key);
  if (prev) delete globalThis[key];
  if (value !== undefined) globalThis[key] = value;
  try {
    fn();
  } finally {
    // Clean up — delete the test value, then restore the original.
    try { delete globalThis[key]; } catch { /* if smoke installed non-configurable, ignore */ }
    if (prev) Object.defineProperty(globalThis, key, prev);
  }
}

// ── 1. Hook missing → false (compaction proceeds normally) ────────

check("hook absent → false (abrain not loaded; compaction proceeds)", () => {
  withHook(undefined, () => {
    if (isPendingVaultDialogBlocking() !== false) throw new Error("expected false");
  });
});

// ── 2. Hook returns false → false ─────────────────────────────────

check("hook returns false → false (no pending; compaction proceeds)", () => {
  withHook(() => false, () => {
    if (isPendingVaultDialogBlocking() !== false) throw new Error("expected false");
  });
});

// ── 3. Hook returns true → true (defer compaction) ────────────────

check("hook returns true → true (vault dialog in flight; INV-K defer)", () => {
  withHook(() => true, () => {
    if (isPendingVaultDialogBlocking() !== true) throw new Error("expected true");
  });
});

// ── 4. Defense-in-depth: hook throws → false ─────────────────────

check("hook throws → false (compaction failures > missed INV-K defer)", () => {
  withHook(() => { throw new Error("intentional hook failure"); }, () => {
    if (isPendingVaultDialogBlocking() !== false) throw new Error("expected false");
  });
});

// ── 5. Strict type robustness (mirror prompt-user-defer semantics) ─

check("hook returns truthy non-bool ('true') → false (strict === true)", () => {
  withHook(() => "true", () => {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("string was treated as true");
    }
  });
});

check("hook returns 1 → false (number coerced is NOT blocking)", () => {
  // Different from prompt-user-defer which uses numbers — here a
  // number leakage means corruption / hook drift, treat as false.
  withHook(() => 1, () => {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("number 1 was treated as blocking");
    }
  });
});

check("hook returns null → false", () => {
  withHook(() => null, () => {
    if (isPendingVaultDialogBlocking() !== false) throw new Error("null was treated as blocking");
  });
});

check("hook returns undefined → false", () => {
  withHook(() => undefined, () => {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("undefined was treated as blocking");
    }
  });
});

check("hook returns object → false", () => {
  withHook(() => ({ inFlight: true }), () => {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("object was treated as blocking");
    }
  });
});

// ── 6. Hook is non-function → false (strict shape) ───────────────

check("hook is a boolean (not a function) → false", () => {
  withHook(true, () => {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("non-function hook was treated as blocking");
    }
  });
});

// ── 7. End-to-end: real vault-authorize publishes the flag ────────
//
// Ties the hook publication (abrain activate) to the hook consumption
// (compaction-tuner defer) against the REAL `vault-authorize.ts`
// module-level lock. Stages vault-authorize.cjs into a tmpDir, then
// simulates the abrain activate() side by publishing the hook
// ourselves (pi extension lifecycle isn't available in smoke).

check("real vault-authorize.isVaultDialogInFlight integrates with the helper", () => {
  const vaDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-auth-"));
  fs.writeFileSync(
    path.join(vaDir, "vault-authorize.cjs"),
    transpile(path.join(repoRoot, "extensions/abrain/vault-authorize.ts")),
  );
  const vaultAuth = require(path.join(vaDir, "vault-authorize.cjs"));

  // Sanity: stable public API present and is a function.
  if (typeof vaultAuth.isVaultDialogInFlight !== "function") {
    throw new Error("vault-authorize.ts must export isVaultDialogInFlight() — stable runtime API");
  }
  if (typeof vaultAuth.__resetVaultDialogLockForTests !== "function") {
    throw new Error("vault-authorize.ts must export __resetVaultDialogLockForTests");
  }

  vaultAuth.__resetVaultDialogLockForTests();
  // Publish the hook the way abrain activate() does — emulate the
  // production defineProperty hardening (configurable:true here only
  // because the smoke needs to delete it in finally; production uses
  // configurable:false).
  Object.defineProperty(globalThis, "__abrainVaultDialogInFlight", {
    value: () => vaultAuth.isVaultDialogInFlight(),
    configurable: true,
    writable: false,
    enumerable: false,
  });
  try {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("with no in-flight dialog, helper should be false");
    }

    // Drive the real askVaultAuthorizationViaDialog with a hanging
    // factory: ui.custom invokes the factory (which captures `done`
    // but never invokes it), then returns `undefined`. Production code
    // tolerates undefined return (`if (ret && typeof ret.then ===
    // "function")` short-circuits). The outer Promise stays pending
    // forever — lock held.
    //
    // Synchronous timing: askVaultAuthorizationViaDialog is async but
    // the body runs synchronously up to the first `await`. That `await`
    // is on __runVaultDialog(args), which itself is async-with-no-
    // -awaits, so it returns its `outer` Promise synchronously. The
    // outer function suspends at the await, the `finally { lock=false }`
    // does NOT run yet, and control returns to us with the lock still
    // held. We can sync-assert the lock state before any microtask
    // flush.
    const fakeUi = {
      custom: (factory) => {
        factory({}, {}, {}, () => { /* swallow done */ });
        return undefined; // production tolerates undefined return
      },
    };
    const hangPromise = vaultAuth.askVaultAuthorizationViaDialog({
      ui: fakeUi,
      variant: "vault_release",
      reason: "smoke",
      header: "smoke",
      question: "?",
      choices: ["No", "Yes once"],
      buildDialog: () => ({}),
    });

    // SYNC assertion — lock was set before the outer Promise was
    // returned. Must check before any microtask flush.
    if (vaultAuth.isVaultDialogInFlight() !== true) {
      throw new Error("expected vault dialog in-flight after entry");
    }
    if (isPendingVaultDialogBlocking() !== true) {
      throw new Error("helper should report true while real lock is held");
    }

    // Release the lock — simulates the finally{} in
    // askVaultAuthorizationViaDialog (resetForTests sets the var
    // directly, simulating the natural release path).
    vaultAuth.__resetVaultDialogLockForTests();
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("helper should report false after lock release");
    }

    // Detach the pending promise (intentional test-only hang).
    void hangPromise;
  } finally {
    try { delete globalThis.__abrainVaultDialogInFlight; } catch {}
    try { fs.rmSync(vaDir, { recursive: true, force: true }); } catch {}
  }
});

// ── 8. Symmetry guard — prompt_user hook stays independent ───────
//
// vault-defer.ts MUST NOT collapse into prompt-user-defer.ts. Verify by
// publishing ONLY the prompt_user hook and confirming the vault helper
// remains false (different hook name → no spurious coupling).

check("prompt_user hook ≠ vault hook (no name-collapse regression)", () => {
  // Only install prompt_user hook.
  globalThis.__abrainPromptUserGetPending = () => 99;
  try {
    if (isPendingVaultDialogBlocking() !== false) {
      throw new Error("vault helper read prompt_user hook — name collapse regression");
    }
  } finally {
    delete globalThis.__abrainPromptUserGetPending;
  }
});

// ── 9. Source anchor — hook name stability ────────────────────────
//
// The hook name `__abrainVaultDialogInFlight` is a cross-extension
// contract. If anyone renames it on either side without renaming both,
// the defer silently breaks (hook absent → false → compaction trigger
// during vault overlay). Grep-anchor against both source files so
// rename refactors fail loudly.

check("source anchor: vault-defer.ts and abrain/index.ts agree on hook name", () => {
  const deferSrc = fs.readFileSync(
    path.join(repoRoot, "extensions/compaction-tuner/vault-defer.ts"),
    "utf8",
  );
  if (!deferSrc.includes("__abrainVaultDialogInFlight")) {
    throw new Error("vault-defer.ts must reference __abrainVaultDialogInFlight");
  }
  const abrainSrc = fs.readFileSync(
    path.join(repoRoot, "extensions/abrain/index.ts"),
    "utf8",
  );
  if (!abrainSrc.includes("__abrainVaultDialogInFlight")) {
    throw new Error("abrain/index.ts must publish __abrainVaultDialogInFlight hook");
  }
  // Also assert the hardening — Object.defineProperty with
  // configurable:false. A plain assignment would let an attacker
  // rebind the hook to () => false and silently defeat the defer.
  if (!abrainSrc.match(/__abrainVaultDialogInFlight[\s\S]{0,400}configurable:\s*false/)) {
    throw new Error(
      "abrain/index.ts must install __abrainVaultDialogInFlight with " +
        "configurable:false — see ADR 0022 Batch C hardening rationale",
    );
  }
});

// ── 10. Trigger-path anchor — compaction-tuner imports the helper ─
//
// compaction-tuner/index.ts must (a) import isPendingVaultDialogBlocking,
// and (b) call it on the trigger path. Without the call site the
// helper is dead code and INV-K vault defer is silently inactive.

check("trigger-path anchor: compaction-tuner/index.ts imports + calls vault helper", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "extensions/compaction-tuner/index.ts"),
    "utf8",
  );
  if (!src.includes('from "./vault-defer"')) {
    throw new Error("compaction-tuner/index.ts must import from ./vault-defer");
  }
  if (!src.includes("isPendingVaultDialogBlocking")) {
    throw new Error("compaction-tuner/index.ts must call isPendingVaultDialogBlocking on trigger path");
  }
  // Audit reason must be distinct from prompt_user.
  if (!src.includes('"vault_dialog_pending"')) {
    throw new Error(
      'compaction-tuner/index.ts must audit reason:"vault_dialog_pending" (distinct from prompt_user_pending) — debuggability',
    );
  }
  if (!src.includes('"prompt_user_pending"')) {
    throw new Error('compaction-tuner/index.ts must KEEP reason:"prompt_user_pending" (do not break audit-schema)');
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
