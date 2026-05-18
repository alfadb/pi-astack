#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0c.read substrate — vaultReader library.
 *
 * Coverage:
 *   1. loadMasterKey fails closed when uninitialized / sub-pi disabled.
 *   2. ssh-key e2e: .vault-master.age unlocks to age secret identity.
 *   3. decryptSecret decrypts a vault/<key>.md.age written by vaultWriter.
 *   4. releaseSecret returns value + placeholder; redaction replaces plaintext.
 *   5. temporary age identity files are removed after decrypt.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  });
  return out.outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vr-"));
// ADR 0019: vault-reader.ts + keychain.ts now import runtime constants from
// ./backend-detect, so include it in the load set.
// ADR 0022 P3b: vault-authorize.ts loaded here as a library to exercise the
// PromptDialog overlay path with a synthetic ctx.ui.custom mock. Pure helpers
// — type-only imports of prompt-user types, no runtime require()s.
for (const file of ["backend-detect", "vault-reader", "vault-writer", "keychain", "vault-authorize"]) {
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), transpile(path.join(repoRoot, "extensions", "abrain", `${file}.ts`)));
}
// Relative imports in transpiled CommonJS keep the original .ts-free names.
for (const file of ["backend-detect", "vault-reader", "vault-writer", "keychain", "vault-authorize"]) {
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}

const reader = require(path.join(tmpDir, "vault-reader.cjs"));
const writer = require(path.join(tmpDir, "vault-writer.cjs"));
const keychain = require(path.join(tmpDir, "keychain.cjs"));
const vaultAuth = require(path.join(tmpDir, "vault-authorize.cjs"));

console.log("abrain P0c.read — vaultReader library");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

function freshUnlockedAbrainHome() {
  const home = fs.mkdtempSync(path.join(tmpDir, "abrain-home-"));
  fs.mkdirSync(path.join(home, ".state"), { recursive: true, mode: 0o700 });

  const sshKey = path.join(home, "test_ed25519");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", sshKey]);

  const masterSecret = path.join(home, "master.age");
  const age = run("age-keygen", ["-o", masterSecret]);
  const m = age.stderr.match(/Public key:\s+(\S+)/);
  if (!m) throw new Error("could not parse age public key");
  const masterPub = m[1];

  const encryptedMaster = path.join(home, ".vault-master.age");
  run("age", ["-R", `${sshKey}.pub`, "-o", encryptedMaster, masterSecret]);
  fs.chmodSync(encryptedMaster, 0o600);

  keychain.writeBackendFile(home, { backend: "ssh-key", identity: sshKey });
  keychain.writePubkeyFile(home, masterPub);

  return { home, sshKey, masterSecret, masterPub };
}

function vaultReadTempDirs(home) {
  const state = path.join(home, ".state");
  if (!fs.existsSync(state)) return [];
  return fs.readdirSync(state).filter((name) => name.startsWith("vault-read-"));
}

await check("loadMasterKey: uninitialized returns null", async () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "uninit-"));
  const mk = await reader.loadMasterKey(home);
  if (mk !== null) throw new Error("expected null master key for uninitialized vault");
});

await check("loadMasterKey: PI_ABRAIN_DISABLED=1 fails closed", async () => {
  const { home } = freshUnlockedAbrainHome();
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  try {
    const mk = await reader.loadMasterKey(home);
    if (mk !== null) throw new Error("sub-pi disabled should not unlock master key");
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

await check("ssh-key e2e: loadMasterKey unlocks .vault-master.age", async () => {
  const { home } = freshUnlockedAbrainHome();
  const mk = await reader.loadMasterKey(home);
  if (!mk) throw new Error("master key did not unlock");
  const text = mk.secretKey.toString("utf8");
  if (!text.startsWith("AGE-SECRET-KEY-")) throw new Error("unlocked master is not an age secret key");
  mk.secretKey.fill(0);
});

await check("decryptSecret: vaultWriter encrypted value decrypts byte-exact", async () => {
  const { home } = freshUnlockedAbrainHome();
  const value = "ghp_test_secret_value\nwith newline";
  await writer.writeSecret({ abrainHome: home, scope: "global", key: "github-token", value });
  const out = await reader.decryptSecret({ abrainHome: home, scope: "global", key: "github-token" });
  const got = out.toString("utf8");
  out.fill(0);
  if (got !== value) throw new Error(`decrypt mismatch: ${JSON.stringify(got)}`);
  const leftovers = vaultReadTempDirs(home);
  if (leftovers.length > 0) throw new Error(`temp identity dirs not cleaned: ${leftovers.join(", ")}`);
});

await check("releaseSecret + redactWithReleasedSecrets: returns placeholder and redacts literal value", async () => {
  const { home } = freshUnlockedAbrainHome();
  const value = "super-secret-value";
  await writer.writeSecret({ abrainHome: home, scope: "global", key: "api-token", value });
  const release = await reader.releaseSecret({ abrainHome: home, scope: "global", key: "api-token" });
  if (release.value !== value) throw new Error("release value mismatch");
  if (release.placeholder !== "<vault:global:api-token>") throw new Error(`placeholder mismatch: ${release.placeholder}`);
  const redacted = reader.redactWithReleasedSecrets(`token=${value}`, [release]);
  if (redacted.includes(value)) throw new Error("redaction leaked plaintext value");
  if (!redacted.includes("<vault:global:api-token>")) throw new Error("redaction missing placeholder");
});

await check("decryptSecret: missing or forgotten key fails closed", async () => {
  const { home } = freshUnlockedAbrainHome();
  let threw = false;
  try {
    await reader.decryptSecret({ abrainHome: home, scope: "global", key: "missing-key" });
  } catch (err) {
    threw = true;
    if (!err.message.includes("not found or forgotten")) throw new Error(`unexpected error: ${err.message}`);
  }
  if (!threw) throw new Error("expected missing key to throw");
});

// ── ADR 0022 P3b: askVaultAuthorizationViaDialog (PromptDialog substrate) ──
//
// These assertions exercise the new overlay path with a synthetic
// ctx.ui.custom mock + a fake buildDialog. The mock captures the factory
// arguments and immediately invokes onDone with a chosen label, mirroring
// how PromptDialog would resolve after user keypresses in a real terminal.
//
// We do NOT load the real PromptDialog — testing the buildDialog wiring is
// covered by smoke:prompt-user. Here we focus on:
//   - vault_release: full 4-choice mapping (No / Deny+remember / Yes once / Session)
//   - bash_output_release: 3-choice variant has NO "Deny + remember"
//   - INV-E: the helper carries NO grant state of its own (no closure side-effect)
//   - INV-D boundary: caller controls audit lane; the helper writes nothing
//   - fallback path: ui.custom missing → ui_unavailable; ui.custom throws → dialog_error
function makeMockUi({ chooseLabel, throwOnCustom = false, recordDone = false }) {
  const events = {
    customCalled: 0,
    factoryVariant: null,
    factoryOptions: null,
    notifications: [],
    doneCalls: [],          // null entries = teardown (mid-dialog abort)
  };
  const ui = {
    notify: (msg, level) => events.notifications.push({ msg, level }),
    custom: (factory, options) => {
      events.customCalled += 1;
      events.factoryOptions = options;
      if (throwOnCustom) throw new Error("synthetic custom failure");
      // pi runtime contract: factory(tui, theme, kb, done) → component.
      // Our fake buildDialog (passed in via args.buildDialog below)
      // captures variant + drives onDone synchronously with the chosen
      // label, simulating an instant user pick.
      return Promise.resolve().then(() => {
        const done = (v) => { if (recordDone) events.doneCalls.push(v); };
        factory({}, {}, {}, done);
      });
    },
  };
  return { ui, events, chooseLabel };
}

// Build a NON-resolving fake dialog (factory captures done but never
// invokes it). Used to verify lock acquisition / teardown without
// racing the happy-path resolution. The dialog stays "open" until
// either signal abort or the test releases the lock by other means.
function makeHangingBuildDialog(captureRef) {
  return (a) => {
    captureRef.variant = a.variant;
    captureRef.optionLabels = a.params.questions[0].options.map((o) => o.label);
    // Capture done so the test can verify whether mid-dialog teardown
    // actually invoked it. DO NOT call done() from this factory.
    captureRef.dialogDoneRef = null; // set by the wrapper's onDone path
    return {};
  };
}

// Fake buildDialog: instead of building a real OptionList, it inspects
// the supplied PromptUserParams + variant and immediately invokes
// onDone with the user's pretend choice. The label MUST match one of
// the choices passed in via params.questions[0].options so the
// askVaultAuthorizationViaDialog "unknown choice" guard does not fire.
function makeFakeBuildDialog(captureRef, pickLabel) {
  return (a) => {
    captureRef.variant = a.variant;
    captureRef.optionLabels = a.params.questions[0].options.map((o) => o.label);
    captureRef.reason = a.params.reason;
    captureRef.header = a.params.questions[0].header;
    // Use queueMicrotask so the caller has a chance to subscribe to the
    // Promise it returned before we resolve.
    queueMicrotask(() => {
      a.onDone(
        pickLabel === "__cancel__"
          ? { outcome: "cancel", answers: {}, rawSecrets: {} }
          : { outcome: "submit", answers: { _vault_decision: [pickLabel] }, rawSecrets: {} },
      );
    });
    return {}; // dummy component
  };
}

await check("P3b: vault_release overlay path — 4 choices map to {choice} correctly", async () => {
  const choices = ["No", "Deny + remember", "Yes once", "Session"];
  for (const pick of choices) {
    const { ui } = makeMockUi({ chooseLabel: pick });
    const capture = {};
    const r = await vaultAuth.askVaultAuthorizationViaDialog({
      ui,
      variant: "vault_release",
      reason: "Release github-token?",
      header: "Release vault key",
      question: "Authorize plaintext release?",
      choices,
      buildDialog: makeFakeBuildDialog(capture, pick),
    });
    if (!r.ok) throw new Error(`pick=${pick}: expected ok, got ${JSON.stringify(r)}`);
    if (r.choice !== pick) throw new Error(`pick=${pick}: got choice=${r.choice}`);
    if (capture.variant !== "vault_release") throw new Error(`variant leaked: ${capture.variant}`);
    if (capture.optionLabels.length !== 4) throw new Error(`expected 4 options, got ${capture.optionLabels.length}`);
    // INV-D-adjacent: vault_release variant must NOT include an Other entry
    // in the options list that the dialog sees (PromptDialog itself enforces
    // this at render time; the params we feed it should not contain Other).
    if (capture.optionLabels.some((l) => /other/i.test(l))) {
      throw new Error(`vault params should not include Other label: ${capture.optionLabels.join(",")}`);
    }
  }
});

await check("P3b: bash_output_release overlay path — 3 choices, no 'Deny + remember'", async () => {
  const choices = ["No", "Yes once", "Session"];
  const { ui } = makeMockUi({ chooseLabel: "Session" });
  const capture = {};
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "bash_output_release",
    reason: "Release bash output?",
    header: "Bash output",
    question: "Release this command's output to the LLM?",
    choices,
    buildDialog: makeFakeBuildDialog(capture, "Session"),
  });
  if (!r.ok || r.choice !== "Session") throw new Error(JSON.stringify(r));
  if (capture.variant !== "bash_output_release") throw new Error(`variant: ${capture.variant}`);
  if (capture.optionLabels.length !== 3) {
    throw new Error(`bash_output expects 3 choices, got ${capture.optionLabels.length}: ${capture.optionLabels.join(",")}`);
  }
  if (capture.optionLabels.includes("Deny + remember")) {
    throw new Error("bash_output_release MUST NOT include 'Deny + remember' (vault-bash.ts contract)");
  }
});

await check("P3b: ui.custom missing → ui_unavailable (caller falls through to select)", async () => {
  const ui = { notify: () => {} }; // no .custom
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    buildDialog: () => { throw new Error("should not be called"); },
  });
  if (r.ok) throw new Error("expected !ok");
  if (r.reason !== "ui_unavailable") throw new Error(`reason: ${r.reason}`);
});

await check("P3b: ui.custom throws → dialog_error (caller falls through to select)", async () => {
  const { ui } = makeMockUi({ chooseLabel: "Yes once", throwOnCustom: true });
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    buildDialog: makeFakeBuildDialog({}, "Yes once"),
  });
  if (r.ok) throw new Error("expected !ok");
  if (r.reason !== "dialog_error") throw new Error(`reason: ${r.reason}`);
  if (!/synthetic custom failure/.test(r.detail ?? "")) {
    throw new Error(`expected error detail to surface, got: ${r.detail}`);
  }
});

await check("P3b INV-E: helper holds no grant state — sequential calls are independent", async () => {
  // Call vault_release twice with different picks. Verify the second
  // call sees no leftover state from the first (helper has zero closure
  // memory). This is the dialog-substrate end of INV-E: PromptDialog +
  // its bridge do NOT carry abrain SoT state. (The grant state machinery
  // in extensions/abrain/index.ts still owns releaseSessionGrants; that
  // half is covered by smoke:abrain-vault-bash + smoke:prompt-user.)
  const choices = ["No", "Deny + remember", "Yes once", "Session"];
  const { ui: ui1 } = makeMockUi({ chooseLabel: "Session" });
  const r1 = await vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui1, variant: "vault_release", reason: "r1", header: "h1", question: "q?",
    choices, buildDialog: makeFakeBuildDialog({}, "Session"),
  });
  if (!r1.ok || r1.choice !== "Session") throw new Error("r1 fail");

  // Second call uses a fresh ui mock; the helper module must not have
  // remembered the previous choice / mocked state. We pick a different
  // label to make sure the helper is reading THIS call's onDone, not
  // anything stale.
  const { ui: ui2 } = makeMockUi({ chooseLabel: "No" });
  const r2 = await vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui2, variant: "vault_release", reason: "r2", header: "h2", question: "q?",
    choices, buildDialog: makeFakeBuildDialog({}, "No"),
  });
  if (!r2.ok || r2.choice !== "No") throw new Error(`r2 unexpectedly returned ${JSON.stringify(r2)}`);

  // Sanity: the helper module itself exports nothing stateful (just the
  // function). Verify that property to catch a regression where someone
  // adds module-level state.
  const keys = Object.keys(vaultAuth).filter((k) => !k.startsWith("_") && k !== "default");
  for (const k of keys) {
    if (typeof vaultAuth[k] !== "function") {
      throw new Error(`vault-authorize.ts exports non-function '${k}' — INV-E forbids module-level state in this helper`);
    }
  }
});

await check("P3b: unknown choice from dialog → cancelled (defense in depth)", async () => {
  // If a synthetic / buggy dialog returns answers.choice not in choices[],
  // the helper must NOT propagate it as ok:true. This guards against an
  // attacker-controlled OptionList variant returning "Approve everything"
  // when the legitimate choices were ["No", "Yes once"].
  const { ui } = makeMockUi({ chooseLabel: "Bogus" });
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    buildDialog: makeFakeBuildDialog({}, "Bogus"),
  });
  if (r.ok) throw new Error(`unknown choice should NOT be ok: ${JSON.stringify(r)}`);
  if (r.reason !== "cancelled") throw new Error(`reason: ${r.reason}`);
});

await check("P3b: cancel outcome → cancelled", async () => {
  const { ui } = makeMockUi({ chooseLabel: "__cancel__" });
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    buildDialog: makeFakeBuildDialog({}, "__cancel__"),
  });
  if (r.ok) throw new Error("expected !ok for cancel");
  if (r.reason !== "cancelled") throw new Error(`reason: ${r.reason}`);
});

await check("P3b: pre-aborted signal → cancelled WITHOUT opening dialog (post-audit fix #1)", async () => {
  // Critical fail-closed property (OPUS/GPT-5.5 P1): if the caller's
  // AbortSignal is already aborted at entry, the helper MUST NOT call
  // ctx.ui.custom. The pre-audit version resolved outer but continued
  // into the try block, causing a stale dialog to flash on screen after
  // the caller had already received `cancelled`.
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui, events } = makeMockUi({ chooseLabel: "Session" });
  const ac = new AbortController();
  ac.abort();
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    signal: ac.signal,
    buildDialog: makeFakeBuildDialog({}, "Session"),
  });
  if (r.ok) throw new Error(`expected !ok for pre-aborted signal: ${JSON.stringify(r)}`);
  if (r.reason !== "cancelled") throw new Error(`reason: ${r.reason}`);
  // HARD assertion (P3b audit tightened): ui.custom MUST NOT be called
  // when signal is pre-aborted. Previously this assertion was wished-but-not-checked.
  if (events.customCalled !== 0) {
    throw new Error(`fail #1: ui.custom called ${events.customCalled} times for pre-aborted signal — stale dialog risk`);
  }
  // Lock must NOT be held after pre-abort fast-reject (returned
  // BEFORE the lock acquisition site).
  if (vaultAuth.__peekVaultDialogLockForTests() !== false) {
    throw new Error("fail #3: vault dialog lock held after pre-aborted fast-reject");
  }
});

// ── P3b post-audit fixes #2-5 + #6 ───────────────────────────────────
//
// These assertions cover the OPUS+GPT-5.5+DEEPSEEK audit findings on
// commit 8abb48b. Each maps to a numbered fix in vault-authorize.ts:
//   #2 mid-dialog abort → actively call done(null) to tear overlay down
//   #3 module-level concurrent gate — second call returns dialog_error
//   #4 shape invariant — choices.length < 2 returns dialog_error
//   #5 narrow signal type check — fake AbortSignals don't crash
//   #6 INV-E refinement — lock is concurrency state, NOT grant state

await check("P3b-fix #2: mid-dialog abort calls done(null) to tear overlay down", async () => {
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui, events } = makeMockUi({ chooseLabel: "Session", recordDone: true });
  const ac = new AbortController();
  // Hanging dialog — done is captured by ui.custom but never invoked
  // from inside the factory. Abort fires from outside; the helper must
  // actively tear down via the captured done ref.
  const promise = vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x",
    header: "x",
    question: "x?",
    choices: ["No", "Yes once"],
    signal: ac.signal,
    buildDialog: () => ({}), // factory returns dummy; never invokes done
  });
  // Wait one microtask for ui.custom's .then() to fire → factory runs →
  // dialogDone captured inside the helper closure.
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const r = await promise;
  if (r.ok) throw new Error(`expected !ok: ${JSON.stringify(r)}`);
  if (r.reason !== "cancelled") throw new Error(`reason: ${r.reason}`);
  // Mid-dialog abort MUST have invoked done(null) exactly once — that
  // is the mechanism by which pi's overlay system closes the dialog.
  if (events.doneCalls.length !== 1) {
    throw new Error(`fix #2: expected exactly 1 done() call from teardown, got ${events.doneCalls.length}: ${JSON.stringify(events.doneCalls)}`);
  }
  if (events.doneCalls[0] !== null) {
    throw new Error(`fix #2: teardown done() must pass null, got ${JSON.stringify(events.doneCalls[0])}`);
  }
  // Lock released after teardown.
  if (vaultAuth.__peekVaultDialogLockForTests() !== false) {
    throw new Error("fix #2: vault dialog lock not released after mid-dialog abort");
  }
});

await check("P3b-fix #3: concurrent vault dialog → second call returns dialog_error", async () => {
  // pi runs sibling tool calls in parallel (extensions.md §680). Two
  // `vault_release` calls in one assistant message would otherwise
  // open two overlapping PromptDialog overlays. Verify the
  // module-level lock rejects the second.
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui: ui1 } = makeMockUi({ chooseLabel: "Session" });
  const { ui: ui2 } = makeMockUi({ chooseLabel: "No" });
  // First call uses hanging dialog (never resolves) so the lock stays held.
  const hangFirst = vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui1,
    variant: "vault_release",
    reason: "first",
    header: "first",
    question: "q?",
    choices: ["No", "Session"],
    buildDialog: () => ({}), // never invokes done
  });
  // Yield so ui.custom's .then() runs and the lock is in-flight.
  await new Promise((r) => setImmediate(r));
  if (vaultAuth.__peekVaultDialogLockForTests() !== true) {
    throw new Error("fix #3: lock NOT acquired after first call entered");
  }
  // Second concurrent call MUST return dialog_error immediately.
  const r2 = await vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui2,
    variant: "vault_release",
    reason: "second",
    header: "second",
    question: "q?",
    choices: ["No", "Session"],
    buildDialog: makeFakeBuildDialog({}, "Session"),
  });
  if (r2.ok) throw new Error(`fix #3: second call should NOT succeed during pending dialog: ${JSON.stringify(r2)}`);
  if (r2.reason !== "dialog_error") throw new Error(`fix #3: expected dialog_error, got ${r2.reason}`);
  if (!/pending/i.test(r2.detail ?? "")) {
    throw new Error(`fix #3: error detail should mention pending, got: ${r2.detail}`);
  }
  // Tear down the hanging first dialog so the lock releases cleanly.
  vaultAuth.__resetVaultDialogLockForTests();
  void hangFirst; // intentionally leaked (test-only hang); finally{} resets module-level lock anyway after this test
});

await check("P3b-fix #3 (continued): lock releases after first call finishes → second call proceeds", async () => {
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui: ui1 } = makeMockUi({ chooseLabel: "Session" });
  const r1 = await vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui1, variant: "vault_release", reason: "first", header: "f", question: "q?",
    choices: ["No", "Session"], buildDialog: makeFakeBuildDialog({}, "Session"),
  });
  if (!r1.ok || r1.choice !== "Session") throw new Error("first call should succeed");
  // After first resolves, lock MUST be released (finally{} block in entry).
  if (vaultAuth.__peekVaultDialogLockForTests() !== false) {
    throw new Error("fix #3: lock NOT released after first call finished");
  }
  // Second call proceeds normally.
  const { ui: ui2 } = makeMockUi({ chooseLabel: "No" });
  const r2 = await vaultAuth.askVaultAuthorizationViaDialog({
    ui: ui2, variant: "vault_release", reason: "second", header: "s", question: "q?",
    choices: ["No", "Session"], buildDialog: makeFakeBuildDialog({}, "No"),
  });
  if (!r2.ok || r2.choice !== "No") throw new Error("second call after release should succeed");
});

await check("P3b-fix #4: empty choices array → dialog_error (shape invariant)", async () => {
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui, events } = makeMockUi({ chooseLabel: "x" });
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x", header: "x", question: "x?",
    choices: [], // INVARIANT VIOLATION
    buildDialog: makeFakeBuildDialog({}, "x"),
  });
  if (r.ok) throw new Error(`empty choices should NOT be ok: ${JSON.stringify(r)}`);
  if (r.reason !== "dialog_error") throw new Error(`reason: ${r.reason}`);
  if (!/>= 2 choices/.test(r.detail ?? "")) {
    throw new Error(`fix #4: detail should mention >= 2 choices requirement: ${r.detail}`);
  }
  // Shape rejection happens BEFORE lock acquisition — verify.
  if (events.customCalled !== 0) throw new Error("fix #4: ui.custom should NOT be called for invalid shape");
});

await check("P3b-fix #4: single-choice array → dialog_error (shape invariant)", async () => {
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui } = makeMockUi({ chooseLabel: "x" });
  const r = await vaultAuth.askVaultAuthorizationViaDialog({
    ui,
    variant: "vault_release",
    reason: "x", header: "x", question: "x?",
    choices: ["Only one"],
    buildDialog: makeFakeBuildDialog({}, "Only one"),
  });
  if (r.ok) throw new Error(`single choice should NOT be ok: ${JSON.stringify(r)}`);
  if (r.reason !== "dialog_error") throw new Error(`reason: ${r.reason}`);
});

await check("P3b-fix #5: fake AbortSignal (no addEventListener) does NOT throw", async () => {
  vaultAuth.__resetVaultDialogLockForTests();
  const { ui } = makeMockUi({ chooseLabel: "Yes once" });
  // Bare object posing as signal — some pi runtimes / test fixtures
  // pass `{}` instead of a real AbortSignal. Pre-fix: TypeError thrown
  // when wiring addEventListener, escaping to tool executor as an
  // unhandled promise rejection. Post-fix: narrow type check, signal
  // wiring silently skipped.
  const fakeSignal = { aborted: false }; // intentionally missing addEventListener
  let threw = null;
  let r;
  try {
    r = await vaultAuth.askVaultAuthorizationViaDialog({
      ui,
      variant: "vault_release",
      reason: "x", header: "x", question: "x?",
      choices: ["No", "Yes once"],
      signal: fakeSignal,
      buildDialog: makeFakeBuildDialog({}, "Yes once"),
    });
  } catch (e) {
    threw = e;
  }
  if (threw) throw new Error(`fix #5: fake signal caused throw: ${threw.message}`);
  if (!r || !r.ok) throw new Error(`fix #5: expected ok with fake signal: ${JSON.stringify(r)}`);
  if (r.choice !== "Yes once") throw new Error(`fix #5: wrong choice: ${r.choice}`);
});

await check("P3b-fix #6 (INV-E refinement): module lock is concurrency state, NOT grant state", async () => {
  // INV-E originally read 'vault-authorize.ts holds no grant state'.
  // P3b post-audit fix #3 introduces a module-level Boolean for the
  // concurrent dialog gate. Verify the distinction:
  //   - The lock IS module-level mutable state (concurrency machinery)
  //   - The lock is NOT grant state (release/remember/session sets are
  //     still owned entirely by index.ts closures)
  //   - INV-E module-state smoke (above) iterates exports and asserts
  //     all are functions; the lock variable is NOT exported.
  vaultAuth.__resetVaultDialogLockForTests();
  // Sanity: lock variable is internal — not in module exports.
  const exportedKeys = Object.keys(vaultAuth).filter((k) => k !== "default");
  for (const k of exportedKeys) {
    if (typeof vaultAuth[k] !== "function") {
      throw new Error(`vault-authorize.ts exported non-function '${k}': ${typeof vaultAuth[k]} — INV-E forbids exposed mutable state`);
    }
  }
  // Verify the only lock-related exports are the two test-helpers:
  // reset (mutate) + peek (read). Both are __ prefixed and named
  // explicitly ForTests to signal non-production status.
  const lockFns = exportedKeys.filter((k) => /VaultDialogLock/i.test(k));
  if (lockFns.length !== 2) {
    throw new Error(`fix #6: expected exactly 2 lock test-helpers, got: ${lockFns.join(",")}`);
  }
  for (const k of lockFns) {
    if (!k.startsWith("__") || !k.endsWith("ForTests")) {
      throw new Error(`fix #6: lock helper '${k}' must be __<name>ForTests to mark as test-only`);
    }
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${total} checks failed`);
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nall ok — abrain P0c.read vaultReader holds (${total} assertions, ssh-key unlock + decrypt verified).`);
