#!/usr/bin/env node
/**
 * Smoke test: abrain-age-key backend (ADR 0019) — e2e roundtrip.
 *
 * Validates:
 *   1. `runInit` with backend=abrain-age-key generates the identity
 *      keypair into ~/.abrain/.vault-identity/{master.age,master.age.pub}.
 *   2. master.age is mode 0600 (ADR 0019 invariant 1).
 *   3. master.age.pub is non-secret (mode 0644 is fine).
 *   4. `.vault-master.age` is NOT written for this backend (single-layer
 *      keypair, ADR 0019 invariant 6).
 *   5. `.vault-pubkey` content == `.vault-identity/master.age.pub` content
 *      (invariant 6 — single keypair, two file aliases).
 *   6. `.vault-backend` records backend=abrain-age-key WITHOUT identity=path
 *      (path is fixed — no cross-device drift).
 *   7. `ensureAbrainGitignoreLines` (the exported helper that runInit
 *      invokes BEFORE encryption — ADR 0019 invariant 2) produces a
 *      well-formed .gitignore, is idempotent on re-run, and preserves
 *      existing rules.
 *   8. `loadMasterKey()` returns the master via the abrain-age-key code
 *      path (fs read, no subprocess).
 *   9. writeSecret() + decryptSecret() roundtrip a real secret value end-to-end.
 *  10. Cross-host failure mode propagates the actionable scp / chmod 0600
 *      diagnostic instead of a generic "vault locked" (self-audit 2026-05-15
 *      caught loadMasterKey's silent catch swallowing this and removed it).
 *
 * Cross-host simulation (covers ADR 0019 §"Identity path drift" rationale):
 *   - After init on "host A", we copy abrain dir to a fresh "host B"
 *     location and verify decryptSecret still works using the SAME
 *     identity path (~/.abrain/.vault-identity/master.age).
 *
 * Strategy: real subprocess for age-keygen/age (since age is on PATH in
 * the alfadb dev environment, same as smoke-abrain-bootstrap.mjs ssh-key
 * e2e). No mocking on the encryption side — we want true age binary
 * compatibility validation.
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

function asyncCheck(name, fn) {
  return (async () => {
    totalChecks++;
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  })();
}

const failures = [];
let totalChecks = 0;

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

// ── Set up isolated tmp abrain home ─────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-identity-"));
const fakeHome = path.join(tmpDir, "home-A");
const abrainHome = path.join(fakeHome, ".abrain");
fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });

// Compile relevant abrain modules into the tmp dir (same pattern as other smokes).
// ADR 0022 P1: "redact" added — git-sync.ts re-exports redactCredentials
// from ./redact. The loop already writes both .cjs and .js aliases.
// ADR 0022 P3b: "vault-authorize" added — abrain/index.ts imports it for
// PromptDialog overlay path on vault release / bash output authorization.
for (const file of [
  "backend-detect",
  "bootstrap",
  "keychain",
  "vault-reader",
  "vault-writer",
  "vault-bash",
  "vault-authorize",
  "brain-layout",
  "i18n",
  "git-sync",
  "redact",
]) {
  // P1-2 audit fix 2026-05-16 round 4: brain-layout.ts now imports
  // `../_shared/runtime` for computeAbrainStateGitignoreNext. Rewrite
  // the relative require uniformly; harmless no-op for files that don't
  // import _shared today.
  const compiled = transpile(path.join(repoRoot, "extensions", "abrain", `${file}.ts`))
    .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")');
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), compiled);
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}
// _shared/runtime is required by index.ts via ../_shared/runtime
fs.mkdirSync(path.join(tmpDir, "_shared"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "_shared", "runtime.cjs"), transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")));
fs.copyFileSync(path.join(tmpDir, "_shared", "runtime.cjs"), path.join(tmpDir, "_shared", "runtime.js"));

const bootstrap = require(path.join(tmpDir, "bootstrap.cjs"));
const keychain = require(path.join(tmpDir, "keychain.cjs"));
const reader = require(path.join(tmpDir, "vault-reader.cjs"));
const writer = require(path.join(tmpDir, "vault-writer.cjs"));

// Pull in index.cjs so we can exercise ensureAbrainGitignoreLines directly.
// index.ts uses relative requires that need rewriting to the .cjs aliases
// we just dropped into tmpDir (same pattern as smoke-abrain-backend-detect).
let indexCompiled = transpile(path.join(repoRoot, "extensions/abrain/index.ts"));
indexCompiled = indexCompiled
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
fs.writeFileSync(path.join(tmpDir, "index.cjs"), indexCompiled);
const indexModule = require(path.join(tmpDir, "index.cjs"));

console.log("abrain-age-key backend (ADR 0019) — e2e roundtrip");

// Helper notifier (handleInit/runInit signature)
const ui = { notify: () => {} };

// ── Pre-roundtrip: ensureAbrainGitignoreLines unit assertion ────
// (Self-audit MAJOR-A fix, 2026-05-15): the previous version of this
// smoke never exercised the gitignore patch even though the file's
// header promised to. We now exercise the exported helper directly
// against a fresh abrain home and verify the produced .gitignore.

check("ensureAbrainGitignoreLines patches a fresh .gitignore with ADR 0019 identity-secret guards", () => {
  const fresh = fs.mkdtempSync(path.join(tmpDir, "gi-fresh-"));
  indexModule.ensureAbrainGitignoreLines(fresh, [
    "# ADR 0019: abrain-age-key identity secret — never enter git",
    ".vault-identity/master.age",
    ".vault-identity/master.age.tmp.*",
  ]);
  const gi = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
  if (!gi.includes(".vault-identity/master.age\n") && !gi.includes(".vault-identity/master.age$") && !gi.match(/^\.vault-identity\/master\.age$/m)) {
    throw new Error(`gitignore missing identity secret guard line, got:\n${gi}`);
  }
  if (!gi.includes(".vault-identity/master.age.tmp.*")) {
    throw new Error(`gitignore missing tmp guard line, got:\n${gi}`);
  }
  if (!gi.includes("ADR 0019")) {
    throw new Error(`gitignore missing ADR comment header, got:\n${gi}`);
  }
});

check("ensureAbrainGitignoreLines is idempotent (rerun does not duplicate)", () => {
  const fresh = fs.mkdtempSync(path.join(tmpDir, "gi-idem-"));
  const lines = [
    "# ADR 0019: abrain-age-key identity secret — never enter git",
    ".vault-identity/master.age",
    ".vault-identity/master.age.tmp.*",
  ];
  indexModule.ensureAbrainGitignoreLines(fresh, lines);
  const before = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
  indexModule.ensureAbrainGitignoreLines(fresh, lines);
  const after = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
  if (before !== after) {
    throw new Error(`second call appended duplicate lines:\n--- before ---\n${before}\n--- after ---\n${after}`);
  }
  // Sanity: identity-secret line appears exactly once
  const occurrences = after.split("\n").filter((l) => l.trim() === ".vault-identity/master.age").length;
  if (occurrences !== 1) {
    throw new Error(`identity secret line appears ${occurrences} times after re-run; expected 1`);
  }
});

check("ensureAbrainGitignoreLines preserves existing .gitignore content (append, not overwrite)", () => {
  const fresh = fs.mkdtempSync(path.join(tmpDir, "gi-preserve-"));
  const existing = "# my custom rules\nnode_modules/\n*.log\n";
  fs.writeFileSync(path.join(fresh, ".gitignore"), existing);
  indexModule.ensureAbrainGitignoreLines(fresh, [
    ".vault-identity/master.age",
  ]);
  const final = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
  if (!final.includes("# my custom rules")) throw new Error("existing comment lost");
  if (!final.includes("node_modules/")) throw new Error("existing rule lost");
  if (!final.includes(".vault-identity/master.age")) throw new Error("new rule not appended");
});

// ── Run init via bootstrap+keychain APIs directly (mimics runInit) ──

const installTmp = bootstrap.createInstallTmpDir(abrainHome);
let publicKey;

await asyncCheck("age-keygen produces master keypair under install tmp", async () => {
  const r = await bootstrap.generateMasterKey(installTmp);
  publicKey = r.publicKey;
  if (!publicKey.startsWith("age1")) throw new Error(`unexpected public key prefix: ${publicKey.slice(0, 12)}`);
  if (!fs.existsSync(r.secretKeyPath)) throw new Error("secret key file missing under install tmp");
});

// We need to drive encryptMasterKey for backend=abrain-age-key.
// The install secret path is deterministic: <installTmp>/master.age.
const installSecretPath = path.join(installTmp, "master.age");

await asyncCheck("encryptMasterKey(abrain-age-key) installs identity files; .vault-master.age is NOT written", async () => {
  await keychain.encryptMasterKey("abrain-age-key", {
    masterSecretPath: installSecretPath,
    masterPublicKey: publicKey,
    identity: undefined,
    vaultMasterEncryptedPath: path.join(abrainHome, ".vault-master.age"),
  }, async (cmd, args) => {
    // For abrain-age-key the implementation doesn't invoke any subprocess;
    // this exec stub should NEVER be called. If it is, the implementation
    // regressed back to ssh-key-style envelope encryption.
    throw new Error(`unexpected exec call: ${cmd} ${args.join(" ")} — abrain-age-key must be subprocess-free`);
  });

  const idSecretPath = path.join(abrainHome, ".vault-identity", "master.age");
  const idPubPath = path.join(abrainHome, ".vault-identity", "master.age.pub");
  if (!fs.existsSync(idSecretPath)) throw new Error(`identity secret not installed at ${idSecretPath}`);
  if (!fs.existsSync(idPubPath)) throw new Error(`identity pubkey not installed at ${idPubPath}`);
  const stat = fs.statSync(idSecretPath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`identity secret has loose perms: 0${(stat.mode & 0o777).toString(8)}; expected 0600`);
  if ((stat.mode & 0o600) !== 0o600) throw new Error(`identity secret missing owner rw: 0${(stat.mode & 0o777).toString(8)}`);

  // .vault-master.age MUST NOT be created for this backend (ADR 0019 invariant 6).
  if (fs.existsSync(path.join(abrainHome, ".vault-master.age"))) {
    throw new Error("abrain-age-key incorrectly wrote .vault-master.age — should use single-layer keypair");
  }
});

// Now write the bookkeeping files (mirroring runInit step 3)
keychain.writePubkeyFile(abrainHome, publicKey);
keychain.writeBackendFile(abrainHome, { backend: "abrain-age-key" });
await bootstrap.cleanupInstallDir(installTmp);

check(".vault-backend records backend=abrain-age-key WITHOUT identity= path", () => {
  const txt = fs.readFileSync(path.join(abrainHome, ".vault-backend"), "utf8");
  if (!txt.includes("backend=abrain-age-key")) throw new Error("missing backend line");
  if (txt.includes("identity=")) throw new Error("identity= should NOT be persisted (path is fixed under ADR 0019)");
});

check(".vault-pubkey content equals .vault-identity/master.age.pub (invariant 6)", () => {
  const a = fs.readFileSync(path.join(abrainHome, ".vault-pubkey"), "utf8").trim();
  const b = fs.readFileSync(path.join(abrainHome, ".vault-identity", "master.age.pub"), "utf8").trim();
  if (a !== b) throw new Error(`mismatch:\n  .vault-pubkey: ${a}\n  master.age.pub: ${b}`);
});

// ── loadMasterKey() — abrain-age-key code path ────────────────

await asyncCheck("loadMasterKey() returns master via abrain-age-key (no subprocess)", async () => {
  let execCalled = false;
  const master = await reader.loadMasterKey(abrainHome, async () => {
    execCalled = true;
    throw new Error("exec must NOT be called for abrain-age-key");
  });
  if (!master) throw new Error("loadMasterKey returned null");
  if (master.backend !== "abrain-age-key") throw new Error(`expected backend abrain-age-key, got ${master.backend}`);
  if (execCalled) throw new Error("subprocess unexpectedly invoked");
  const txt = master.secretKey.toString("utf8");
  if (!txt.startsWith("AGE-SECRET-KEY-")) throw new Error("master key is not an age secret identity");
});

// ── Secret write + read roundtrip ─────────────────────────────

const testSecret = "abrain-identity-roundtrip-VALUE-2026-05-15";

await asyncCheck("writeSecret writes encrypted .md.age via abrain identity pubkey", async () => {
  await writer.writeSecret({
    abrainHome,
    scope: "global",
    key: "test-key",
    value: testSecret,
  });
  const enc = path.join(abrainHome, "vault", "test-key.md.age");
  if (!fs.existsSync(enc)) throw new Error(`encrypted entry missing at ${enc}`);
  // age v1 binary format starts with the literal magic string
  // 'age-encryption.org/' (no PEM armor by default — vault-writer uses
  // `age -r <pub>` without `-a`).
  const raw = fs.readFileSync(enc);
  const head = raw.slice(0, 64).toString("utf8");
  if (!head.includes("age-encryption.org/")) throw new Error(`entry is not age format (head=${JSON.stringify(head)})`);
});

await asyncCheck("decryptSecret reads back via abrain-age-key path → plaintext matches", async () => {
  const plaintext = await reader.decryptSecret({
    abrainHome,
    scope: "global",
    key: "test-key",
  });
  if (plaintext.toString("utf8") !== testSecret) {
    throw new Error(`plaintext mismatch:\n  expected: ${testSecret}\n  got:      ${plaintext.toString("utf8")}`);
  }
});

// ── Cross-host simulation (the user-stated motivating scenario) ─

const fakeHomeB = path.join(tmpDir, "home-B");
const abrainHomeB = path.join(fakeHomeB, ".abrain");
fs.mkdirSync(abrainHomeB, { recursive: true, mode: 0o700 });

await asyncCheck("★ cross-host: copy abrain dir to fresh path → decryptSecret still works (identity path is fixed)", async () => {
  // Simulate "git clone abrain + secure transport of identity secret"
  // by copying the full abrain dir to a new location. Critical: same
  // ~/.abrain/.vault-identity/master.age path on both "machines".
  for (const rel of [".vault-backend", ".vault-pubkey", ".vault-identity/master.age", ".vault-identity/master.age.pub", "vault/test-key.md.age"]) {
    const src = path.join(abrainHome, rel);
    const dst = path.join(abrainHomeB, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    // Preserve 0600 on identity secret
    if (rel.includes("master.age") && !rel.endsWith(".pub")) {
      fs.chmodSync(dst, 0o600);
    }
  }
  const plaintext = await reader.decryptSecret({
    abrainHome: abrainHomeB,
    scope: "global",
    key: "test-key",
  });
  if (plaintext.toString("utf8") !== testSecret) {
    throw new Error(`cross-host plaintext mismatch:\n  expected: ${testSecret}\n  got:      ${plaintext.toString("utf8")}`);
  }
});

await asyncCheck("★ cross-host without identity copy: decryptSecret fails with actionable error", async () => {
  // Simulate "user git-clones abrain to a 3rd machine but FORGETS to copy
  // the identity secret" — this is the dogfood scenario we want to fail
  // loudly, not silently.
  const homeC = path.join(tmpDir, "home-C");
  const abrainHomeC = path.join(homeC, ".abrain");
  fs.mkdirSync(abrainHomeC, { recursive: true, mode: 0o700 });
  // Copy everything EXCEPT the identity secret
  for (const rel of [".vault-backend", ".vault-pubkey", ".vault-identity/master.age.pub", "vault/test-key.md.age"]) {
    const src = path.join(abrainHome, rel);
    const dst = path.join(abrainHomeC, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
  }
  let caught = null;
  try {
    await reader.decryptSecret({ abrainHome: abrainHomeC, scope: "global", key: "test-key" });
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error("missing identity should have triggered an error");
  const msg = String(caught.message ?? caught);
  // ADR 0019 cross-host UX promise: error must carry the actionable scp
  // instruction so the user knows what to do, not a generic "vault locked".
  // self-audit 2026-05-15 (opus-4-7 catch): loadMasterKey's silent catch
  // used to swallow this — ensure it stays propagated.
  if (!msg.includes("identity secret missing")) {
    throw new Error(`error missing identity-missing diagnostic: ${msg}`);
  }
  if (!msg.includes("scp")) {
    throw new Error(`error missing scp transport hint (ADR 0019 cross-host UX): ${msg}`);
  }
  if (!msg.includes("chmod 0600")) {
    throw new Error(`error missing chmod hint: ${msg}`);
  }
});

// ── Done ─────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain-age-key e2e + cross-host roundtrip (${totalChecks} assertions).`);
} else {
  console.error(`FAIL — ${failures.length} of ${totalChecks} assertions failed.`);
  process.exit(1);
}

// cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
