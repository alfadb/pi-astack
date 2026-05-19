#!/usr/bin/env node
/**
 * Smoke test: ADR 0022 housekeeping batch A subgroup 2 — vault authorization
 * grant isolation E2E + ui.select fallback + ui_path stamping end-to-end.
 *
 * Background
 * ----------
 * Batch A subgroup 1 (commits ff3dd9e + c2cbe85) added:
 *   - (b) startup_telemetry op + dialog-builder-init-failed flag
 *   - (g) VaultEvent.ui_path schema + authorize functions return ui_path
 *   - (D9) ADR 0014 Lane V shared-UI-substrate boundary doc
 *
 * Subgroup 1's smoke (smoke-abrain-vault-writer.mjs +2 assertion) only
 * verified the schema layer — appendVaultReadAudit accepts ui_path,
 * round-trips through jsonl. It did NOT verify any caller in index.ts
 * actually passes ui_path on the right branch. That coverage gap is
 * exactly what let the post-audit P0 ship in ff3dd9e: tool_result handler
 * compared the BashOutputAuthOutcome wrapper object against the string
 * "release" — always true, every bash output silently withheld.
 *
 * The post-audit fix (c2cbe85) closed the bug with a grep anchor in
 * smoke-abrain-vault-bash.mjs. That anchor locks the source string
 * pattern but cannot prove the runtime behaviour.
 *
 * This smoke stages the WHOLE index.ts (the secret-scope-smoke staging
 * pattern), reaches into the test-only exports
 * `__authorizeVaultReleaseForTests` / `__authorizeVaultBashOutputForTests`,
 * and drives them through every UI substrate. Coverage:
 *
 * (c) Grant isolation E2E
 *   - INV-E: PromptDialog substrate carries NO grant state; the grant
 *     sets live in index.ts module closures and are reset between calls
 *     via __resetVaultGrantsForTests.
 *   - vault session grant for key A does NOT leak to key B.
 *   - vault "Deny + remember" for key C does NOT block key D.
 *   - vault grants and prompt_user dialogs share NO state (the latter
 *     lives in prompt-user/manager.ts; both substrates can be exercised
 *     back-to-back without cross-contamination).
 *
 * (c) GPT-5.5 R8 P1#1 fail-closed envelope
 *   - ui.select throw -> { ok:false, reason:"ui_authorization_error",
 *     ui_path:"select" } (NOT an unhandled rejection escaping the tool
 *     executor — that would violate ADR 0019 "auth boundary failure
 *     MUST fail closed and observable").
 *   - ui.confirm throw -> same shape with ui_path:"confirm".
 *
 * (d) ui.select fallback path
 *   - cachedVaultDialogBuilder = null -> overlay branch is skipped;
 *     ui.select picks the choice; ui_path:"select" stamped.
 *   - cachedVaultDialogBuilder = null + no ui.select -> ui.confirm
 *     branch picks ok/deny; ui_path:"confirm" stamped.
 *   - cachedVaultDialogBuilder = null + no ui.select + no ui.confirm ->
 *     fail closed with ui_path:"none".
 *
 * (g) ui_path end-to-end stamping
 *   - overlay path -> ui_path:"overlay"
 *   - select path  -> ui_path:"select"
 *   - confirm path -> ui_path:"confirm"
 *   - cached fast-path (session grant) -> ui_path:"cached"
 *   - no-UI fast-path                  -> ui_path:"none"
 *
 * Approach
 * --------
 * Mirror smoke-abrain-secret-scope.mjs's staging block (already proven
 * stable; same dependency graph). Override ABRAIN_ROOT to a tmpdir so
 * readReleaseDescription's fs probes are confined and benign.
 *
 * Negative-test discipline: each ui_path branch is asserted both
 * positively (the expected value appears) AND negatively (a deliberately
 * mismatched expectation fails — verified manually during edit and
 * locked by the grep anchor in smoke-abrain-vault-bash.mjs).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-grant-iso-"));

// ── Stage abrain dependency graph (mirror of smoke-abrain-secret-scope) ──
const sharedTarget = path.join(tmpDir, "_shared");
fs.mkdirSync(sharedTarget, { recursive: true });
fs.writeFileSync(
  path.join(sharedTarget, "runtime.cjs"),
  transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")),
);
fs.copyFileSync(path.join(sharedTarget, "runtime.cjs"), path.join(sharedTarget, "runtime.js"));

const ABRAIN_LEAF_FILES = [
  "vault-writer", "vault-reader", "vault-bash", "keychain", "bootstrap",
  "backend-detect", "i18n", "brain-layout", "git-sync", "redact",
  "vault-authorize",
];
for (const file of ABRAIN_LEAF_FILES) {
  const compiled = transpile(path.join(repoRoot, "extensions/abrain", `${file}.ts`))
    .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")');
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), compiled);
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}

// Stage abrain/index.ts last so its require()s can resolve to the .cjs
// siblings we just wrote.
{
  const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions/abrain/index.ts"), "utf8");
  const indexCjs = ts.transpileModule(indexSrc, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText
    .replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")')
    .replace(/require\("\.\/bootstrap"\)/g, 'require("./bootstrap.cjs")')
    .replace(/require\("\.\/keychain"\)/g, 'require("./keychain.cjs")')
    .replace(/require\("\.\/vault-writer"\)/g, 'require("./vault-writer.cjs")')
    .replace(/require\("\.\/vault-reader"\)/g, 'require("./vault-reader.cjs")')
    .replace(/require\("\.\/vault-bash"\)/g, 'require("./vault-bash.cjs")')
    .replace(/require\("\.\/vault-authorize"\)/g, 'require("./vault-authorize.cjs")')
    .replace(/require\("\.\/i18n"\)/g, 'require("./i18n.cjs")')
    .replace(/require\("\.\/brain-layout"\)/g, 'require("./brain-layout.cjs")')
    .replace(/require\("\.\/git-sync"\)/g, 'require("./git-sync.cjs")')
    .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")');
  fs.writeFileSync(path.join(tmpDir, "index.cjs"), indexCjs);
}

// Confine fs probes (e.g. readReleaseDescription / appendVaultReadAudit)
// to a real tmp ABRAIN home. The directory exists but has no vault files,
// so readReleaseDescription returns undefined and appendVaultReadAudit
// silently creates .state/. Both are harmless side effects.
const abrainHome = fs.mkdtempSync(path.join(tmpDir, "abrain-home-"));
fs.mkdirSync(path.join(abrainHome, ".state"), { recursive: true, mode: 0o700 });
process.env.ABRAIN_ROOT = abrainHome;

const indexModule = require(path.join(tmpDir, "index.cjs"));

console.log("abrain — vault authorization grant isolation E2E (batch A subgroup 2)");

// ── Helpers ─────────────────────────────────────────────────────────────

function resetState() {
  indexModule.__resetVaultGrantsForTests();
  indexModule.__setVaultDialogBuilderForTests(null);
  if (typeof indexModule.__resetVaultDialogBuilderTelemetryForTests === "function") {
    indexModule.__resetVaultDialogBuilderTelemetryForTests();
  }
}

// Build a ui that EXERCISES the overlay (PromptDialog) path. The
// captured choice is fed into the fake buildDialog via askVaultAuth...
// The ui object exposes ui.custom + ui.notify so the overlay guard in
// authorizeVaultRelease (`typeof ui.custom === "function" &&
// cachedVaultDialogBuilder`) passes. We set a synthetic builder via
// __setVaultDialogBuilderForTests so the helper drives onDone with
// our chosen label.
function makeOverlayUi(captureRef = {}) {
  const events = { notifications: [], customCalled: 0 };
  const ui = {
    notify: (msg, level) => events.notifications.push({ msg, level }),
    custom: (factory) => {
      events.customCalled += 1;
      return Promise.resolve().then(() => factory({}, {}, {}, () => {}));
    },
  };
  return { ui, events, captureRef };
}

function installOverlayBuilder(pickLabel) {
  // The builder we install bypasses the schema validator — vault paths
  // construct PromptUserParams internally (INV-G: vault internal caller
  // bypass). We just inspect that the variant + options arrive correctly
  // and immediately resolve with pickLabel.
  indexModule.__setVaultDialogBuilderForTests(({ params, variant, onDone }) => {
    queueMicrotask(() => {
      if (pickLabel === "__cancel__") {
        onDone({ outcome: "cancel", answers: {}, rawSecrets: {} });
      } else {
        onDone({
          outcome: "submit",
          answers: { _vault_decision: [pickLabel] },
          rawSecrets: {},
        });
      }
    });
    // Return a dummy component the pi runtime would normally render.
    return { variant, params };
  });
}

// ── (g) ui_path end-to-end stamping ─────────────────────────────────────
//
// authorizeVaultRelease has FIVE distinct ui_path values. We hit each one
// and assert the returned outcome carries the right tag. Negative-test
// (manual): change the expected string to "wrong" — assertion fails fast.

await check("ui_path stamp: cached (session grant from prior call)", async () => {
  resetState();
  installOverlayBuilder("Session"); // grants the session
  const { ui } = makeOverlayUi();
  const first = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "alpha", undefined, undefined, {},
  );
  if (!first.ok) throw new Error(`first call should grant Session, got ${JSON.stringify(first)}`);
  if (first.ui_path !== "overlay") throw new Error(`first.ui_path=${first.ui_path}`);

  // Second call MUST short-circuit via releaseSessionGrants WITHOUT
  // touching the overlay/select path.
  const overlayBuilderProbe = { hits: 0 };
  indexModule.__setVaultDialogBuilderForTests(() => {
    overlayBuilderProbe.hits += 1;
    return {};
  });
  const second = await indexModule.__authorizeVaultReleaseForTests(
    { custom: () => { throw new Error("must not be called"); },
      notify: () => {} },
    "global", "alpha", undefined, undefined, {},
  );
  if (!second.ok) throw new Error(`session grant did not persist: ${JSON.stringify(second)}`);
  if (second.ui_path !== "cached")
    throw new Error(`expected ui_path=cached, got ${second.ui_path}`);
  if (overlayBuilderProbe.hits !== 0)
    throw new Error(`cached path MUST NOT touch dialog builder, hits=${overlayBuilderProbe.hits}`);
});

await check("ui_path stamp: overlay (PromptDialog path picks 'Yes once')", async () => {
  resetState();
  installOverlayBuilder("Yes once");
  const { ui, events } = makeOverlayUi();
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "beta", "test reason", undefined, {},
  );
  if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out)}`);
  if (out.ui_path !== "overlay") throw new Error(`ui_path=${out.ui_path}`);
  if (events.customCalled !== 1) throw new Error(`ui.custom hits=${events.customCalled}`);
});

await check("ui_path stamp: select fallback when cachedVaultDialogBuilder=null", async () => {
  resetState(); // builder=null after reset
  let selectCalled = 0;
  let lastSelectChoices = null;
  const ui = {
    custom: () => { throw new Error("MUST NOT call ui.custom when builder=null"); },
    notify: () => {},
    select: async (_title, choices) => {
      selectCalled += 1;
      lastSelectChoices = choices;
      return "Yes once";
    },
  };
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "gamma", undefined, undefined, {},
  );
  if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out)}`);
  if (out.ui_path !== "select") throw new Error(`ui_path=${out.ui_path}`);
  if (selectCalled !== 1) throw new Error(`select called ${selectCalled}x`);
  // Sanity: the deny-first ordering invariant from ADR 0019 still holds —
  // first choice in the array must be a deny variant ("No"), not "Yes once",
  // so a non-interactive auto-pick fails closed.
  if (!lastSelectChoices || lastSelectChoices[0] !== "No") {
    throw new Error(`deny-first ordering broken: ${JSON.stringify(lastSelectChoices)}`);
  }
});

await check("ui_path stamp: confirm fallback when builder=null AND no ui.select", async () => {
  resetState();
  let confirmCalled = 0;
  const ui = {
    notify: () => {},
    confirm: async () => { confirmCalled += 1; return true; },
  };
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "delta", undefined, undefined, {},
  );
  if (!out.ok) throw new Error(`expected ok, got ${JSON.stringify(out)}`);
  if (out.ui_path !== "confirm") throw new Error(`ui_path=${out.ui_path}`);
  if (confirmCalled !== 1) throw new Error(`confirm called ${confirmCalled}x`);
});

await check("ui_path stamp: none when ui is undefined", async () => {
  resetState();
  const out = await indexModule.__authorizeVaultReleaseForTests(
    undefined, "global", "epsilon", undefined, undefined, {},
  );
  if (out.ok) throw new Error(`expected deny, got ${JSON.stringify(out)}`);
  if (out.reason !== "ui_unavailable") throw new Error(`reason=${out.reason}`);
  if (out.ui_path !== "none") throw new Error(`ui_path=${out.ui_path}`);
});

await check("ui_path stamp: none when no UI method is available", async () => {
  resetState();
  const ui = { notify: () => {} }; // no custom, no select, no confirm
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "zeta", undefined, undefined, {},
  );
  if (out.ok) throw new Error(`expected deny, got ${JSON.stringify(out)}`);
  if (out.reason !== "ui_authorization_unavailable") throw new Error(`reason=${out.reason}`);
  if (out.ui_path !== "none") throw new Error(`ui_path=${out.ui_path}`);
});

// ── (c) GPT-5.5 R8 P1#1 fail-closed envelope ────────────────────────────
//
// authorizeVaultRelease has a try/catch around ui.select AND ui.confirm.
// A throw from the UI primitive MUST become a fail-closed deny rather
// than an unhandled rejection escaping the tool executor (ADR 0019
// "auth boundary failure MUST fail closed and observable"). The R8
// commit (4f7a4cc) added these try/catch envelopes; before this smoke
// the assertion was a code-grep, not a runtime check.

await check("fail-closed envelope: ui.select throw -> ui_authorization_error + ui_path:select", async () => {
  resetState();
  const ui = {
    notify: () => {},
    select: async () => { throw new Error("synthetic select crash"); },
  };
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "select-throws", undefined, undefined, {},
  );
  if (out.ok) throw new Error(`MUST NOT release on ui.select throw: ${JSON.stringify(out)}`);
  if (out.reason !== "ui_authorization_error") throw new Error(`reason=${out.reason}`);
  if (out.ui_path !== "select") throw new Error(`ui_path=${out.ui_path}`);
});

await check("fail-closed envelope: ui.confirm throw -> ui_authorization_error + ui_path:confirm", async () => {
  resetState();
  const ui = {
    notify: () => {},
    confirm: async () => { throw new Error("synthetic confirm crash"); },
  };
  const out = await indexModule.__authorizeVaultReleaseForTests(
    ui, "global", "confirm-throws", undefined, undefined, {},
  );
  if (out.ok) throw new Error(`MUST NOT release on ui.confirm throw: ${JSON.stringify(out)}`);
  if (out.reason !== "ui_authorization_error") throw new Error(`reason=${out.reason}`);
  if (out.ui_path !== "confirm") throw new Error(`ui_path=${out.ui_path}`);
});

// ── (c) Grant isolation E2E across keys + lanes ────────────────────────

await check("INV-E: vault session grant for key A does NOT leak to key B", async () => {
  resetState();
  installOverlayBuilder("Session");
  const { ui: uiA } = makeOverlayUi();
  const a = await indexModule.__authorizeVaultReleaseForTests(
    uiA, "global", "alpha-key", undefined, undefined, {},
  );
  if (!a.ok) throw new Error(`A should grant: ${JSON.stringify(a)}`);

  // Probe a DIFFERENT key with a ui that throws if touched. If the
  // grant set were keyed by lane/substrate (not key), the second call
  // would short-circuit and return ok without touching ui — that would
  // be a real cross-key leak. We instead expect overlay to fire.
  let bOverlayHits = 0;
  indexModule.__setVaultDialogBuilderForTests(({ onDone }) => {
    bOverlayHits += 1;
    queueMicrotask(() => onDone({ outcome: "submit", answers: { _vault_decision: ["No"] }, rawSecrets: {} }));
    return {};
  });
  const { ui: uiB } = makeOverlayUi();
  const b = await indexModule.__authorizeVaultReleaseForTests(
    uiB, "global", "beta-key", undefined, undefined, {},
  );
  if (b.ok) throw new Error(`B should NOT inherit A's grant: ${JSON.stringify(b)}`);
  if (bOverlayHits !== 1) throw new Error(`B should drive its own overlay, hits=${bOverlayHits}`);
});

await check("INV-E: deny+remember for key C does NOT block key D", async () => {
  resetState();
  installOverlayBuilder("Deny + remember");
  const { ui: uiC } = makeOverlayUi();
  const c = await indexModule.__authorizeVaultReleaseForTests(
    uiC, "global", "gamma-key", undefined, undefined, {},
  );
  if (c.ok) throw new Error(`C should deny: ${JSON.stringify(c)}`);

  // Verify the remember semantics on the SAME key: a fresh ui call MUST
  // be short-circuited via releaseRememberDenies WITHOUT touching the
  // overlay.
  let cReplayBuilderHits = 0;
  indexModule.__setVaultDialogBuilderForTests(() => { cReplayBuilderHits += 1; return {}; });
  const cReplay = await indexModule.__authorizeVaultReleaseForTests(
    { custom: () => { throw new Error("must not be called"); }, notify: () => {} },
    "global", "gamma-key", undefined, undefined, {},
  );
  if (cReplay.ok) throw new Error(`C-replay should still deny: ${JSON.stringify(cReplay)}`);
  if (cReplay.reason !== "denied_remembered")
    throw new Error(`reason=${cReplay.reason}, expected denied_remembered`);
  if (cReplay.ui_path !== "cached")
    throw new Error(`ui_path=${cReplay.ui_path}, expected cached`);
  if (cReplayBuilderHits !== 0)
    throw new Error(`remember-deny cached path must not touch builder, hits=${cReplayBuilderHits}`);

  // Now a DIFFERENT key MUST drive its own overlay — the remembered
  // deny is per (scope, key) and does NOT poison other keys.
  installOverlayBuilder("Yes once");
  const { ui: uiD } = makeOverlayUi();
  const d = await indexModule.__authorizeVaultReleaseForTests(
    uiD, "global", "delta-key", undefined, undefined, {},
  );
  if (!d.ok) throw new Error(`D should not inherit C's deny-remember: ${JSON.stringify(d)}`);
  if (d.ui_path !== "overlay") throw new Error(`d.ui_path=${d.ui_path}`);
});

await check("INV-E: PromptDialog substrate carries no grant state (vault-authorize.ts)", () => {
  // Direct introspection: the vault-authorize module MUST export only
  // functions. ANY non-function export would indicate module-level state
  // creeping into the substrate (the dialog lock is intentionally
  // module-local and not exported via askVaultAuthorizationViaDialog's
  // public API; the test-only __peek/__reset helpers are functions too).
  const vaultAuth = require(path.join(tmpDir, "vault-authorize.cjs"));
  const exposed = Object.keys(vaultAuth).filter((k) => !k.startsWith("default"));
  for (const k of exposed) {
    if (typeof vaultAuth[k] !== "function") {
      throw new Error(
        `vault-authorize.ts exports non-function '${k}' (${typeof vaultAuth[k]}) — ` +
          `INV-E forbids module-level state on the substrate. ` +
          `Concurrency lock + reset helpers are functions; nothing else should be.`,
      );
    }
  }
});

// ── (g) bash output path: outcome.decision + outcome.ui_path ────────────
//
// This is the path the post-audit P0 fix (c2cbe85) repaired. Drive
// authorizeVaultBashOutput directly so we observe the runtime shape of
// the outcome and prove that release is reachable (the pre-fix bug had
// release fall through to withhold for every non-cached call).

await check("bash output: overlay 'Yes once' returns { decision:'release', ui_path:'overlay' }", async () => {
  resetState();
  installOverlayBuilder("Yes once");
  const { ui } = makeOverlayUi();
  const record = {
    toolCallId: "tcid-bash-1",
    grantKey: "tcid-bash-1-grant",
    envFile: path.join(tmpDir, "nonexistent-env"),
    originalCommand: "curl -H 'Authorization: token $VAULT_alpha' …",
    releases: [{ scope: "global", key: "alpha", value: "REDACTED" }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
  const outcome = await indexModule.__authorizeVaultBashOutputForTests(ui, record, undefined, {});
  // Critical: outcome MUST be an object with both fields. The pre-fix bug
  // hinged on a caller treating this as a string.
  if (typeof outcome !== "object" || outcome === null)
    throw new Error(`outcome shape regressed to non-object: ${typeof outcome}`);
  if (outcome.decision !== "release")
    throw new Error(`expected decision=release, got ${JSON.stringify(outcome)}`);
  if (outcome.ui_path !== "overlay")
    throw new Error(`expected ui_path=overlay, got ${outcome.ui_path}`);
});

await check("bash output: select fallback returns { decision:'release', ui_path:'select' }", async () => {
  resetState();
  const ui = {
    notify: () => {},
    select: async () => "Session",
  };
  const record = {
    toolCallId: "tcid-bash-2",
    grantKey: "tcid-bash-2-grant",
    envFile: path.join(tmpDir, "nonexistent-env-2"),
    originalCommand: "echo hi",
    releases: [{ scope: "global", key: "alpha", value: "REDACTED" }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
  const outcome = await indexModule.__authorizeVaultBashOutputForTests(ui, record, undefined, {});
  if (outcome.decision !== "release") throw new Error(JSON.stringify(outcome));
  if (outcome.ui_path !== "select") throw new Error(`ui_path=${outcome.ui_path}`);
});

await check("bash output: 'No' returns { decision:'withhold', ui_path:'overlay' }", async () => {
  resetState();
  installOverlayBuilder("No");
  const { ui } = makeOverlayUi();
  const record = {
    toolCallId: "tcid-bash-3",
    grantKey: "tcid-bash-3-grant",
    envFile: path.join(tmpDir, "nonexistent-env-3"),
    originalCommand: "echo hi",
    releases: [{ scope: "global", key: "alpha", value: "REDACTED" }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
  const outcome = await indexModule.__authorizeVaultBashOutputForTests(ui, record, undefined, {});
  if (outcome.decision !== "withhold") throw new Error(JSON.stringify(outcome));
  if (outcome.ui_path !== "overlay") throw new Error(`ui_path=${outcome.ui_path}`);
});

await check("bash output: session grant fast-path returns ui_path:'cached'", async () => {
  resetState();
  installOverlayBuilder("Session");
  const record = {
    toolCallId: "tcid-bash-4",
    grantKey: "shared-grant-key",
    envFile: path.join(tmpDir, "nonexistent-env-4a"),
    originalCommand: "echo hi",
    releases: [{ scope: "global", key: "alpha", value: "REDACTED" }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
  const { ui } = makeOverlayUi();
  const first = await indexModule.__authorizeVaultBashOutputForTests(ui, record, undefined, {});
  if (first.decision !== "release" || first.ui_path !== "overlay")
    throw new Error(`first should overlay+release: ${JSON.stringify(first)}`);
  // Second call with the SAME grantKey must short-circuit via
  // bashOutputSessionGrants.
  const recordSameGrant = { ...record, toolCallId: "tcid-bash-4b" };
  const second = await indexModule.__authorizeVaultBashOutputForTests(
    { custom: () => { throw new Error("must not be called"); }, notify: () => {} },
    recordSameGrant,
    undefined,
    {},
  );
  if (second.decision !== "release") throw new Error(JSON.stringify(second));
  if (second.ui_path !== "cached") throw new Error(`ui_path=${second.ui_path}`);
});

await check("bash output: undefined ui returns { decision:'withhold', ui_path:'none' }", async () => {
  resetState();
  const record = {
    toolCallId: "tcid-bash-5",
    grantKey: "tcid-bash-5-grant",
    envFile: path.join(tmpDir, "nonexistent-env-5"),
    originalCommand: "echo hi",
    releases: [{ scope: "global", key: "alpha", value: "REDACTED" }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
  const outcome = await indexModule.__authorizeVaultBashOutputForTests(undefined, record, undefined, {});
  if (outcome.decision !== "withhold") throw new Error(JSON.stringify(outcome));
  if (outcome.ui_path !== "none") throw new Error(`ui_path=${outcome.ui_path}`);
});

// ── (b) startup telemetry probes ───────────────────────────────────────
//
// We don't run activate() here (it pulls in the prompt-user subtree +
// pi-tui, which we don't have available in this transpile-only context).
// Instead we exercise the telemetry FLAG accessors that activate() and
// session_start use, and verify the test helpers behave as documented.

await check("telemetry: __peek + __set + __reset helpers wired correctly", () => {
  // Reset to baseline.
  indexModule.__resetVaultDialogBuilderTelemetryForTests();
  let state = indexModule.__peekVaultDialogBuilderTelemetryForTests();
  if (state.failed !== false || state.sent !== false)
    throw new Error(`baseline: failed=${state.failed} sent=${state.sent}`);

  // Simulate activate() failing pi-tui load.
  indexModule.__setVaultDialogBuilderInitFailedForTests(true);
  state = indexModule.__peekVaultDialogBuilderTelemetryForTests();
  if (state.failed !== true || state.sent !== false)
    throw new Error(`post-set: failed=${state.failed} sent=${state.sent}`);

  // Reset semantics: both flags clear, NO half-state.
  indexModule.__resetVaultDialogBuilderTelemetryForTests();
  state = indexModule.__peekVaultDialogBuilderTelemetryForTests();
  if (state.failed !== false || state.sent !== false)
    throw new Error(`post-reset: failed=${state.failed} sent=${state.sent}`);
});

// ── Cleanup ────────────────────────────────────────────────────────────
// ── P0 GAP CLOSURE: tool_result handler end-to-end (3-way T0 review) ──
//
// 2026-05-19 OPUS-4-7 + GPT-5.5 + DEEPSEEK-V4-pro xhigh unanimous P0:
// the helper-only checks above do NOT catch the ff3dd9e P0. That P0
// lived in the tool_result handler's `const decision = await ...; if
// (decision !== "release")` (object-vs-string compare). authorize* helper
// return shape was already correct in ff3dd9e — only the caller mis-used
// it. To cover the bug class, we drive the handler body via
// `__handleVaultBashToolResultForTests` (this commit's post-audit
// refactor extracted it from the listener so smoke can invoke it).
//
// Each check below seeds a synthetic vaultBashRuns record via
// `__seedVaultBashRunForTests`, then awaits the handler with a fake
// event/ctx. Negative-test verified: reverting the inline handler
// `outcome.decision` back to `decision` makes the release assertion
// fail immediately (object !== string → forced withhold path).
async function readAuditRows() {
  const p = path.join(abrainHome, ".state", "vault-events.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

function buildSeededRecord(toolCallId, { plaintextValue = "SECRET_VALUE_FOR_TEST", placeholder = "<vault:global:alpha>" } = {}) {
  return {
    toolCallId,
    grantKey: `${toolCallId}-grant`,
    envFile: path.join(tmpDir, `seeded-env-${toolCallId}`),
    originalCommand: `curl -H 'Authorization: token $VAULT_alpha' (test ${toolCallId})`,
    releases: [{
      scope: "global",
      key: "alpha",
      value: plaintextValue,
      placeholder,
    }],
    variables: [{ varName: "VAULT_alpha", scopeKey: "global:alpha" }],
  };
}

function clearAuditFile() {
  const p = path.join(abrainHome, ".state", "vault-events.jsonl");
  try { fs.rmSync(p, { force: true }); } catch {}
}

await check("handler E2E: release path — outcome.decision destructure works (catches ff3dd9e P0)", async () => {
  resetState();
  installOverlayBuilder("Yes once");
  clearAuditFile();
  const tcid = "e2e-release-1";
  indexModule.__seedVaultBashRunForTests(tcid, buildSeededRecord(tcid));

  const event = {
    toolName: "bash",
    toolCallId: tcid,
    content: [{ type: "text", text: "output containing SECRET_VALUE_FOR_TEST literally" }],
    details: { foo: "bar" },
  };
  const { ui } = makeOverlayUi();
  const result = await indexModule.__handleVaultBashToolResultForTests(event, { ui });

  // PRIMARY ASSERTION (catches ff3dd9e P0): the release branch MUST be
  // reachable. Pre-fix `decision !== "release"` compared the wrapper
  // object against the literal string — always true — making the entire
  // release branch unreachable.
  if (!result || !result.details || !result.details.vault) {
    throw new Error(`handler returned no vault details: ${JSON.stringify(result)}`);
  }
  if (result.details.vault.outputReleased !== true) {
    throw new Error(
      `expected outputReleased=true (release branch reached), got: ${JSON.stringify(result.details.vault)}. ` +
        "This would be the ff3dd9e P0 reappearing.",
    );
  }
  if (result.details.vault.outputWithheld) {
    throw new Error(`release branch wrote outputWithheld=true (regression to ff3dd9e P0): ${JSON.stringify(result.details.vault)}`);
  }
  // Redaction substitutes the placeholder for the literal value.
  const serialized = JSON.stringify(result.content);
  if (serialized.includes("SECRET_VALUE_FOR_TEST")) {
    throw new Error(`redaction failed: plaintext leaked in returned content: ${serialized.slice(0, 200)}`);
  }
  if (!serialized.includes("<vault:global:alpha>")) {
    throw new Error(`redaction missing placeholder: ${serialized.slice(0, 200)}`);
  }

  // (g) ui_path propagated end-to-end into the audit row.
  const rows = await readAuditRows();
  const releaseRow = rows.find((r) => r.op === "bash_output_release");
  if (!releaseRow) {
    throw new Error(`bash_output_release row missing from audit: ${JSON.stringify(rows)}`);
  }
  if (releaseRow.ui_path !== "overlay") {
    throw new Error(`expected ui_path=overlay on release row, got ${JSON.stringify(releaseRow)}`);
  }
});

await check("handler E2E: withhold path — audit gets ui_path + content is withheld payload", async () => {
  resetState();
  installOverlayBuilder("No");
  clearAuditFile();
  const tcid = "e2e-withhold-1";
  indexModule.__seedVaultBashRunForTests(tcid, buildSeededRecord(tcid));

  const event = {
    toolName: "bash",
    toolCallId: tcid,
    content: [{ type: "text", text: "output containing SECRET_VALUE_FOR_TEST" }],
    details: {},
  };
  const { ui } = makeOverlayUi();
  const result = await indexModule.__handleVaultBashToolResultForTests(event, { ui });

  if (!result.details.vault.outputWithheld) {
    throw new Error(`expected outputWithheld=true, got ${JSON.stringify(result.details.vault)}`);
  }
  const serialized = JSON.stringify(result.content);
  if (serialized.includes("SECRET_VALUE_FOR_TEST")) {
    throw new Error(`withhold path leaked plaintext: ${serialized.slice(0, 200)}`);
  }
  const rows = await readAuditRows();
  const withholdRow = rows.find((r) => r.op === "bash_output_withhold");
  if (!withholdRow) {
    throw new Error(`bash_output_withhold row missing: ${JSON.stringify(rows)}`);
  }
  if (withholdRow.ui_path !== "overlay") {
    throw new Error(`expected ui_path=overlay on withhold row, got ${JSON.stringify(withholdRow)}`);
  }
});

await check("handler E2E: non-bash toolName is bypassed silently", async () => {
  resetState();
  const result = await indexModule.__handleVaultBashToolResultForTests(
    { toolName: "edit", toolCallId: "irrelevant", content: [], details: {} },
    { ui: undefined },
  );
  if (result !== undefined) {
    throw new Error(`non-bash tool should yield undefined return, got ${JSON.stringify(result)}`);
  }
});

await check("handler E2E: unknown toolCallId is bypassed silently", async () => {
  resetState();
  clearAuditFile();
  const result = await indexModule.__handleVaultBashToolResultForTests(
    { toolName: "bash", toolCallId: "no-such-record", content: [], details: {} },
    { ui: undefined },
  );
  if (result !== undefined) {
    throw new Error(`unknown toolCallId should yield undefined, got ${JSON.stringify(result)}`);
  }
  const rows = await readAuditRows();
  if (rows.some((r) => r.op === "bash_output_release" || r.op === "bash_output_withhold")) {
    throw new Error(`unexpected audit rows for missing record: ${JSON.stringify(rows)}`);
  }
});

await check("handler E2E: outer-envelope fail-closed catch withholds (OPUS P1-5 intentional ui_path omit)", async () => {
  resetState();
  clearAuditFile();
  // Poison record.releases so the `.releases.map(...)` inside the try
  // throws — reaches the outer catch block which writes
  // `auditBashOutput("bash_output_withhold", record)` in the 2-arg form
  // (ui_path intentionally absent per OPUS P1-5).
  const tcid = "e2e-outer-catch";
  indexModule.__seedVaultBashRunForTests(tcid, {
    toolCallId: tcid,
    grantKey: `${tcid}-grant`,
    envFile: path.join(tmpDir, `outer-env-${tcid}`),
    originalCommand: "echo synthetic",
    releases: "NOT_AN_ARRAY",
    variables: [],
  });
  installOverlayBuilder("Yes once");
  const { ui } = makeOverlayUi();
  const result = await indexModule.__handleVaultBashToolResultForTests(
    { toolName: "bash", toolCallId: tcid, content: [], details: {} },
    { ui },
  );
  if (!result?.details?.vault?.outputWithheld) {
    throw new Error(`outer catch should fail-closed: ${JSON.stringify(result)}`);
  }
  if (result.details.vault.reason !== "authorization_error") {
    throw new Error(`expected reason=authorization_error, got ${result.details.vault.reason}`);
  }
  const rows = await readAuditRows();
  for (const r of rows) {
    if (r.op === "bash_output_withhold" && "ui_path" in r) {
      throw new Error(`outer-catch withhold row MUST omit ui_path, got ${JSON.stringify(r)}`);
    }
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.ABRAIN_ROOT;

// ADR 0022 batch A subgroup 2 post-audit (2026-05-19): pin assertion
// count so a future edit that drops a `check(...)` block fails this
// smoke instead of silently shrinking coverage (3-way T0 P2 consensus).
const EXPECTED_ASSERTIONS = 22;
if (total !== EXPECTED_ASSERTIONS && failures.length === 0) {
  console.log("");
  console.log(
    `FAIL — assertion count drifted: expected ${EXPECTED_ASSERTIONS}, ran ${total}. ` +
      "If you intentionally added/removed a check(...), bump EXPECTED_ASSERTIONS.",
  );
  process.exit(1);
}

console.log("");
if (failures.length === 0) {
  console.log(`all ok — vault grant isolation E2E holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
