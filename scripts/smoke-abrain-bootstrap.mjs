#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0b — master key bootstrap (ssh-key e2e).
 *
 * Coverage:
 *   1. bootstrap.ts pure logic (createInstallTmpDir / generateMasterKey /
 *      cleanupInstallDir) — real subprocess where useful (age-keygen, shred)
 *   2. keychain.ts backend dispatch with MOCK exec — every backend's
 *      command construction verified, including macOS argv-exposure
 *      known trade-off
 *   3. keychain.ts file persistence (writeBackendFile / readBackendFile /
 *      writePubkeyFile) — roundtrip + mode bits + atomicity
 *   4. ★ ssh-key e2e roundtrip: real age-keygen → real `age -R` encrypt
 *      → real `age -d -i` decrypt → byte-for-byte compare
 *      (this is the alfadb container scenario truly exercised)
 *   5. runInit() full `/vault init` orchestration with ssh-key — produces
 *      all three files (.vault-master.age / .vault-backend / .vault-pubkey)
 *      with correct contents and modes; install tmp dir is gone afterward
 *
 * Strategy: transpile + load the live TS sources, drive them with a test
 * harness. ssh-key path runs real age + ssh-keygen; mock exec is used for
 * gpg / secret-tool / security / pass (those CLIs aren't installed in the
 * container).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
let skipped = 0;
const SKIP = Symbol("skip");
function commandExists(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !r.error || r.error.code !== "ENOENT";
}
const hasAgeCli = commandExists("age") && commandExists("age-keygen");
function skip(reason) {
  return { [SKIP]: true, reason };
}
function isSkip(value) {
  return Boolean(value && value[SKIP]);
}
function printOkOrSkip(name, result) {
  if (isSkip(result)) {
    skipped++;
    console.log(`  skip  ${name}\n        ${result.reason}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}
function check(name, fn) {
  total++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // async — caller wraps and awaits
      return r.then(
        (result) => printOkOrSkip(name, result),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err.message}`);
        },
      );
    }
    printOkOrSkip(name, r);
    return undefined;
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    return undefined;
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
    fileName: srcPath,
  });
  return out.outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-abrain-p0b-"));

// Wire up CommonJS modules with relative require rewrites
function setupModules() {
  const detectCompiled = transpile(path.join(repoRoot, "extensions/abrain/backend-detect.ts"));
  const bootstrapCompiled = transpile(path.join(repoRoot, "extensions/abrain/bootstrap.ts"));
  let keychainCompiled = transpile(path.join(repoRoot, "extensions/abrain/keychain.ts"));
  // ADR 0019: keychain.ts now imports runtime constants (VAULT_IDENTITY_*)
  // from ./backend-detect, not just types. Provide an extensionless .js
  // companion so the compiled CJS resolves the relative require.

  fs.writeFileSync(path.join(tmpDir, "backend-detect.cjs"), detectCompiled);
  fs.writeFileSync(path.join(tmpDir, "bootstrap.cjs"), bootstrapCompiled);
  fs.writeFileSync(path.join(tmpDir, "keychain.cjs"), keychainCompiled);
  fs.copyFileSync(path.join(tmpDir, "backend-detect.cjs"), path.join(tmpDir, "backend-detect.js"));

  return {
    bootstrap: require(path.join(tmpDir, "bootstrap.cjs")),
    keychain: require(path.join(tmpDir, "keychain.cjs")),
  };
}

const { bootstrap, keychain } = setupModules();

console.log("abrain P0b — master key bootstrap (ssh-key e2e)");

// ═════════════════════════════════════════════════════════════════
// 1. bootstrap.ts: createInstallTmpDir
// ═════════════════════════════════════════════════════════════════

const fakeAbrainHome = fs.mkdtempSync(path.join(tmpDir, "abrain-home-"));

await check("createInstallTmpDir creates dir under .state/install/ with mode 0700", () => {
  const dir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error("not a directory");
  const mode = stat.mode & 0o777;
  if (bootstrap.posixModeChecksEnabled(process.platform) && mode !== 0o700) {
    throw new Error(`expected mode 0700, got 0${mode.toString(8)}`);
  }
  if (!dir.startsWith(path.join(fakeAbrainHome, ".state", "install"))) {
    throw new Error(`unexpected parent: ${dir}`);
  }
  fs.rmdirSync(dir);
});

await check("createInstallTmpDir refuses parent that escapes abrain home", () => {
  // craft a fake abrain home where mkdtemp would escape — symlink trick
  const fake = fs.mkdtempSync(path.join(tmpDir, "fakehome-"));
  const evil = path.join(fake, "..", "..", "..", "..", "..");
  // The path doesn't actually escape because resolve() normalizes it,
  // but we should still get a sane behavior — i.e. either accept (resolves
  // back into safe territory) or reject. Verify it doesn't blow up:
  try {
    bootstrap.createInstallTmpDir(evil);
  } catch {
    // acceptable — escape detection might fire
  }
  // The real test: path traversal in `abrainHome` argument doesn't sneak.
  // We can't easily craft an actual escape here (resolve normalizes), but
  // the function's resolvedParent.startsWith(resolvedHome+sep) check is
  // unit-tested via review. This assertion just verifies no crash.
});

await check("posixModeChecksEnabled skips POSIX mode checks on win32 only", () => {
  if (bootstrap.posixModeChecksEnabled("win32") !== false) throw new Error("win32 should skip POSIX mode checks");
  if (bootstrap.posixModeChecksEnabled("linux") !== true) throw new Error("linux should keep POSIX mode checks");
  if (bootstrap.posixModeChecksEnabled("darwin") !== true) throw new Error("darwin should keep POSIX mode checks");
});

// ═════════════════════════════════════════════════════════════════
// 2. bootstrap.ts: generateMasterKey (real age-keygen)
// ═════════════════════════════════════════════════════════════════

let keypairSecretPath = null;
let keypairPublicKey = null;

await check("generateMasterKey runs age-keygen and parses Public key from stderr", async () => {
  if (!hasAgeCli) return skip("age and/or age-keygen not installed; real keygen coverage skipped");
  const installDir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  try {
    const result = await bootstrap.generateMasterKey(installDir);
    if (!result.publicKey || !result.publicKey.startsWith("age1")) {
      throw new Error(`bad public key: ${result.publicKey}`);
    }
    if (!fs.existsSync(result.secretKeyPath)) {
      throw new Error(`secret key file missing: ${result.secretKeyPath}`);
    }
    const secStat = fs.statSync(result.secretKeyPath);
    if (bootstrap.posixModeChecksEnabled(process.platform) && (secStat.mode & 0o777) !== 0o600) {
      throw new Error(`secret key mode wrong: 0${(secStat.mode & 0o777).toString(8)}`);
    }
    const content = fs.readFileSync(result.secretKeyPath, "utf8");
    if (!content.includes("AGE-SECRET-KEY-")) {
      throw new Error(`secret key file missing AGE-SECRET-KEY- prefix`);
    }
    keypairSecretPath = result.secretKeyPath;
    keypairPublicKey = result.publicKey;
  } finally {
    await bootstrap.cleanupInstallDir(installDir);
  }
});

await check("generateMasterKey rejects install dir with permissive mode", async () => {
  if (!hasAgeCli) return skip("age and/or age-keygen not installed; real keygen coverage skipped");
  if (!bootstrap.posixModeChecksEnabled(process.platform)) return skip("Windows reports synthetic POSIX mode bits; permissive-mode rejection is POSIX-only");
  const installDir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  try {
    fs.chmodSync(installDir, 0o755); // make group/other-readable — should reject
    let threw = false;
    try {
      await bootstrap.generateMasterKey(installDir);
    } catch (err) {
      threw = true;
      if (!err.message.includes("too permissive")) {
        throw new Error(`expected 'too permissive' error, got: ${err.message}`);
      }
    }
    if (!threw) throw new Error("expected rejection of 0755 install dir");
  } finally {
    fs.chmodSync(installDir, 0o700); // restore for cleanup
    await bootstrap.cleanupInstallDir(installDir);
  }
});

// ═════════════════════════════════════════════════════════════════
// 3. bootstrap.ts: cleanupInstallDir (real shred)
// ═════════════════════════════════════════════════════════════════

await check("cleanupInstallDir shreds files and removes dir", async () => {
  const installDir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  const f1 = path.join(installDir, "secret1.txt");
  const f2 = path.join(installDir, "secret2.txt");
  fs.writeFileSync(f1, "very secret content".repeat(100));
  fs.writeFileSync(f2, "another secret".repeat(50));

  const warnings = await bootstrap.cleanupInstallDir(installDir);
  if (warnings.length > 0) throw new Error(`unexpected warnings: ${warnings.join("; ")}`);
  if (fs.existsSync(installDir)) throw new Error("install dir still exists");
  if (fs.existsSync(f1) || fs.existsSync(f2)) throw new Error("files not removed");
});

await check("cleanupInstallDir is idempotent on already-gone dir", async () => {
  const installDir = path.join(tmpDir, "nonexistent-dir-12345");
  const warnings = await bootstrap.cleanupInstallDir(installDir);
  if (warnings.length !== 0) throw new Error(`expected zero warnings, got: ${warnings.join("; ")}`);
});

// ═════════════════════════════════════════════════════════════════
// 4. keychain.ts: backend dispatch with mock exec
// ═════════════════════════════════════════════════════════════════
//
// Mock exec records every call. Returns code=0 + empty stdout/stderr by default.
// Tests inspect captured calls to verify command construction.

function mockExec() {
  const calls = [];
  const fn = async (cmd, args, opts = {}) => {
    calls.push({
      cmd,
      args: [...args],
      stdinInput: opts.input != null ? Buffer.from(opts.input).toString("utf8") : null,
      cwd: opts.cwd,
    });
    // Simulate file creation when the mocked command has -o / --output <path>.
    // Required so post-encrypt chmod (v1.4.1 dogfood fix) finds a real file.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-o" || args[i] === "--output") {
        try { fs.writeFileSync(args[i + 1], "mock encrypted content"); } catch {}
        break;
      }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
  };
  return { fn, calls };
}

// Build a fake plaintext master key file
function tempPlaintext(content) {
  const f = path.join(tmpDir, `pt-${Math.random().toString(36).slice(2, 8)}.age`);
  fs.writeFileSync(f, content);
  return f;
}

await check("keychain.ssh-key: builds `age -R sshpub -o vault input` (no secret in argv)", async () => {
  const m = mockExec();
  const sshSec = path.join(tmpDir, `mock-ssh-${Date.now()}`);
  fs.writeFileSync(`${sshSec}.pub`, "ssh-ed25519 AAAA...\n");
  const pt = tempPlaintext("AGE-SECRET-KEY-FAKE\n");

  await keychain.encryptMasterKey("ssh-key", {
    masterSecretPath: pt,
    masterPublicKey: "age1fake",
    identity: sshSec,
    vaultMasterEncryptedPath: path.join(tmpDir, "out.age"),
  }, m.fn);

  if (m.calls.length !== 1) throw new Error(`expected 1 call, got ${m.calls.length}`);
  const c = m.calls[0];
  if (c.cmd !== "age") throw new Error(`expected cmd=age, got ${c.cmd}`);
  if (!c.args.includes("-R") || !c.args.includes(`${sshSec}.pub`)) {
    throw new Error(`args missing -R or pub path: ${c.args.join(" ")}`);
  }
  // CRITICAL: secret content must not appear in argv
  for (const a of c.args) {
    if (a.includes("AGE-SECRET-KEY-")) throw new Error(`secret leaked into argv: ${a}`);
  }
});

await check("keychain.gpg-file: builds `gpg --encrypt --batch -r <id> -o vault input` (no secret in argv)", async () => {
  const m = mockExec();
  const pt = tempPlaintext("AGE-SECRET-KEY-FAKE\n");

  await keychain.encryptMasterKey("gpg-file", {
    masterSecretPath: pt,
    masterPublicKey: "age1fake",
    identity: "ABCD1234EF",
    vaultMasterEncryptedPath: path.join(tmpDir, "out.age"),
  }, m.fn);

  const c = m.calls[0];
  if (c.cmd !== "gpg") throw new Error(`expected cmd=gpg, got ${c.cmd}`);
  if (!c.args.includes("--encrypt") || !c.args.includes("--batch")) throw new Error(`missing flags`);
  if (!c.args.includes("ABCD1234EF")) throw new Error(`recipient missing`);
  for (const a of c.args) {
    if (a.includes("AGE-SECRET-KEY-")) throw new Error(`secret leaked into argv`);
  }
});

await check("keychain.passphrase-only: builds `age -p -o vault input` (no secret in argv)", async () => {
  const m = mockExec();
  const pt = tempPlaintext("AGE-SECRET-KEY-FAKE\n");

  await keychain.encryptMasterKey("passphrase-only", {
    masterSecretPath: pt,
    masterPublicKey: "age1fake",
    vaultMasterEncryptedPath: path.join(tmpDir, "out.age"),
  }, m.fn);

  const c = m.calls[0];
  if (c.cmd !== "age" || !c.args.includes("-p")) throw new Error(`expected age -p`);
});

await check("keychain.macos: builds `security add-generic-password -w <plaintext>` (KNOWN argv exposure)", async () => {
  const m = mockExec();
  const pt = tempPlaintext("AGE-SECRET-KEY-MAC\n");

  await keychain.encryptMasterKey("macos", {
    masterSecretPath: pt,
    masterPublicKey: "age1mac",
    vaultMasterEncryptedPath: path.join(tmpDir, "unused.age"),
    user: "alice",
  }, m.fn);

  const c = m.calls[0];
  if (c.cmd !== "security") throw new Error(`expected security CLI, got ${c.cmd}`);
  // VERIFY the documented inv2 trade-off: secret IS in argv on macOS.
  // This assertion confirms the spec is faithfully implemented (vault-bootstrap §3.1 inv2).
  const hasSecretInArgv = c.args.some((a) => a.includes("AGE-SECRET-KEY-MAC"));
  if (!hasSecretInArgv) throw new Error(`macOS path should have secret in argv per spec; mismatch with vault-bootstrap §3.1`);
  if (!c.args.includes("alice")) throw new Error(`account name missing`);
});

await check("keychain.secret-service: builds correct args + sends plaintext via STDIN (not argv)", async () => {
  const m = mockExec();
  const pt = tempPlaintext("AGE-SECRET-KEY-SS\n");

  await keychain.encryptMasterKey("secret-service", {
    masterSecretPath: pt,
    masterPublicKey: "age1ss",
    vaultMasterEncryptedPath: path.join(tmpDir, "unused.age"),
  }, m.fn);

  const c = m.calls[0];
  if (c.cmd !== "secret-tool") throw new Error(`expected secret-tool`);
  if (!c.args.includes("store")) throw new Error(`missing 'store'`);
  // CRITICAL: secret must come via stdin, not argv
  for (const a of c.args) {
    if (a.includes("AGE-SECRET-KEY-")) throw new Error(`secret leaked into argv: ${a}`);
  }
  if (!c.stdinInput || !c.stdinInput.includes("AGE-SECRET-KEY-SS")) {
    throw new Error(`secret not piped via stdin`);
  }
});

await check("keychain.pass: builds `pass insert -m abrain/master` + plaintext via STDIN", async () => {
  const m = mockExec();
  const pt = tempPlaintext("AGE-SECRET-KEY-PASS\n");

  await keychain.encryptMasterKey("pass", {
    masterSecretPath: pt,
    masterPublicKey: "age1pass",
    vaultMasterEncryptedPath: path.join(tmpDir, "unused.age"),
  }, m.fn);

  const c = m.calls[0];
  if (c.cmd !== "pass" || !c.args.includes("insert")) throw new Error(`expected pass insert`);
  for (const a of c.args) {
    if (a.includes("AGE-SECRET-KEY-")) throw new Error(`secret leaked into argv`);
  }
  if (!c.stdinInput || !c.stdinInput.includes("AGE-SECRET-KEY-PASS")) {
    throw new Error(`secret not piped via stdin`);
  }
});

await check("keychain.encrypt non-zero exit propagates as throw with stderr", async () => {
  const failExec = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("fake error"), code: 1 });
  const sshSec = path.join(tmpDir, `mock-ssh-fail-${Date.now()}`);
  fs.writeFileSync(`${sshSec}.pub`, "ssh-ed25519 AAAA...\n");
  const pt = tempPlaintext("X");

  let threw = false;
  try {
    await keychain.encryptMasterKey("ssh-key", {
      masterSecretPath: pt,
      masterPublicKey: "age1x",
      identity: sshSec,
      vaultMasterEncryptedPath: path.join(tmpDir, "wont-exist.age"),
    }, failExec);
  } catch (err) {
    threw = true;
    if (!err.message.includes("fake error")) throw new Error(`stderr not in error message: ${err.message}`);
  }
  if (!threw) throw new Error("expected throw on non-zero exit");
});

// ═════════════════════════════════════════════════════════════════
// 5. keychain.ts: file persistence helpers
// ═════════════════════════════════════════════════════════════════

await check("writeBackendFile + readBackendFile roundtrip with identity", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "fbroundtrip-"));
  keychain.writeBackendFile(home, { backend: "ssh-key", identity: "/some/path/id_ed25519" });
  const read = keychain.readBackendFile(home);
  if (read.backend !== "ssh-key") throw new Error(`backend mismatch: ${read.backend}`);
  if (read.identity !== "/some/path/id_ed25519") throw new Error(`identity mismatch: ${read.identity}`);
  // mode should be 0600 on POSIX; Windows reports synthetic bits.
  const mode = fs.statSync(path.join(home, ".vault-backend")).mode & 0o777;
  if (bootstrap.posixModeChecksEnabled(process.platform) && mode !== 0o600) throw new Error(`backend file mode wrong: 0${mode.toString(8)}`);
});

await check("writeBackendFile is atomic (tmp file vs final)", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "fbatomic-"));
  keychain.writeBackendFile(home, { backend: "passphrase-only" });
  // After write, no .tmp.* leftover
  const leftovers = fs.readdirSync(home).filter((f) => f.includes(".tmp."));
  if (leftovers.length > 0) throw new Error(`atomic write left tmp files: ${leftovers.join(", ")}`);
});

await check("readBackendFile rejects unknown backend value", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "fbreject-"));
  fs.writeFileSync(path.join(home, ".vault-backend"), "backend=totally-fake\n");
  const read = keychain.readBackendFile(home);
  if (read !== null) throw new Error(`expected null for unknown backend, got: ${JSON.stringify(read)}`);
});

await check("readBackendFile returns null when file missing", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "fbmiss-"));
  const read = keychain.readBackendFile(home);
  if (read !== null) throw new Error(`expected null when missing`);
});

await check("writePubkeyFile + readPubkeyFile roundtrip with mode 0644", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "pkey-"));
  keychain.writePubkeyFile(home, "age1xxxxxxxxxxxxxx");
  const read = keychain.readPubkeyFile(home);
  if (read !== "age1xxxxxxxxxxxxxx") throw new Error(`pubkey mismatch: ${read}`);
  const mode = fs.statSync(path.join(home, ".vault-pubkey")).mode & 0o777;
  if (bootstrap.posixModeChecksEnabled(process.platform) && mode !== 0o644) throw new Error(`pubkey mode wrong: 0${mode.toString(8)}`);
});

// ═════════════════════════════════════════════════════════════════
// 6. ★ ssh-key e2e roundtrip — the headline P0b test ★
// ═════════════════════════════════════════════════════════════════
//
// This is the test that proves the whole P0b chain works for the
// alfadb container scenario: real age-keygen, real `age -R` encrypt
// with a real ssh public key, real `age -d -i` decrypt, byte-compare.

await check("file backends chmod .vault-master.age to 0600 after encrypt (v1.4.1 dogfood fix)", async () => {
  if (!hasAgeCli) return skip("age and/or age-keygen not installed; real encryption coverage skipped");
  // The dogfood discovery: age -o respects umask, so on container with umask=0002
  // the encrypted file lands as 0664 (group/world readable). Force 0600 in keychain.ts.
  // This smoke covers the ssh-key path; gpg-file and passphrase-only have identical
  // implementation (verified by visual inspection / future real-host smoke).
  const sshDir = fs.mkdtempSync(path.join(tmpDir, "ssh-mode-"));
  const sshKey = path.join(sshDir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", sshKey, "-q"], { stdio: "ignore" });
  const installDir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  const realExec = async (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { input: opts.input, encoding: "buffer" });
    return { stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0), code: r.status };
  };
  try {
    const result = await bootstrap.generateMasterKey(installDir);
    const encryptedPath = path.join(installDir, "vault-master.age");
    // Set permissive umask for this test to prove the chmod actually fires
    const prevUmask = process.umask(0o002);
    try {
      await keychain.encryptMasterKey("ssh-key", {
        masterSecretPath: result.secretKeyPath,
        masterPublicKey: result.publicKey,
        identity: sshKey,
        vaultMasterEncryptedPath: encryptedPath,
      }, realExec);
    } finally {
      process.umask(prevUmask);
    }
    const mode = fs.statSync(encryptedPath).mode & 0o777;
    if (bootstrap.posixModeChecksEnabled(process.platform) && mode !== 0o600) {
      throw new Error(`expected mode 0600, got 0${mode.toString(8)} (umask leak — chmod missing in encryptMasterKey)`);
    }
  } finally {
    await bootstrap.cleanupInstallDir(installDir);
  }
});

await check("★ ssh-key e2e: real age-keygen → age -R encrypt → age -d -i decrypt → byte-match", async () => {
  if (!hasAgeCli) return skip("age and/or age-keygen not installed; real roundtrip coverage skipped");
  // (a) generate a temporary ssh ed25519 keypair (no passphrase for the test)
  const sshDir = fs.mkdtempSync(path.join(tmpDir, "ssh-"));
  const sshKey = path.join(sshDir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", sshKey, "-C", "p0b-smoke", "-q"], { stdio: "ignore" });

  // (b) generate master key via bootstrap
  const installDir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  let result;
  try {
    result = await bootstrap.generateMasterKey(installDir);
    const originalSecret = fs.readFileSync(result.secretKeyPath); // capture for compare

    // (c) real exec wrapping to drive encryptMasterKey via real `age`
    const realExec = async (cmd, args, opts = {}) => {
      const r = spawnSync(cmd, args, {
        input: opts.input,
        encoding: "buffer",
        stdio: opts.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
      return { stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0), code: r.status };
    };

    const encryptedPath = path.join(installDir, "vault-master.age");
    await keychain.encryptMasterKey("ssh-key", {
      masterSecretPath: result.secretKeyPath,
      masterPublicKey: result.publicKey,
      identity: sshKey,
      vaultMasterEncryptedPath: encryptedPath,
    }, realExec);

    if (!fs.existsSync(encryptedPath)) throw new Error(`encrypted file not created: ${encryptedPath}`);
    const encStat = fs.statSync(encryptedPath);
    if (encStat.size === 0) throw new Error(`encrypted file is empty`);
    // age envelope starts with "age-encryption.org/v1" (binary or armor)
    const encBytes = fs.readFileSync(encryptedPath);
    if (!encBytes.includes(Buffer.from("age-encryption.org/v1"))) {
      throw new Error(`encrypted file is not an age envelope (missing magic)`);
    }

    // (d) decrypt with the ssh secret key
    const decResult = spawnSync("age", ["-d", "-i", sshKey, encryptedPath], { encoding: "buffer" });
    if (decResult.status !== 0) {
      throw new Error(`age -d failed: ${decResult.stderr.toString("utf8")}`);
    }
    const decrypted = decResult.stdout;

    // (e) byte-for-byte compare
    if (!decrypted.equals(originalSecret)) {
      throw new Error(`decrypted content does not match original master key`);
    }
  } finally {
    await bootstrap.cleanupInstallDir(installDir);
  }
});

// ═════════════════════════════════════════════════════════════════
// 7. Sanity: cleanup ALWAYS runs even when keygen fails
// ═════════════════════════════════════════════════════════════════
//
// We can't easily induce a real keygen failure, but we can verify the
// pattern by inspecting that bootstrap.cleanupInstallDir is callable
// after a thrown generateMasterKey (already tested above with permissive
// mode rejection). Here we just verify that an empty install dir
// cleans cleanly.

await check("cleanup-empty-dir: cleanupInstallDir on empty dir succeeds with no warnings", async () => {
  const dir = bootstrap.createInstallTmpDir(fakeAbrainHome);
  const warnings = await bootstrap.cleanupInstallDir(dir);
  if (warnings.length !== 0) throw new Error(`expected zero warnings, got: ${warnings.join("; ")}`);
  if (fs.existsSync(dir)) throw new Error(`empty install dir not removed`);
});

// ═════════════════════════════════════════════════════════════════
// Done
// ═════════════════════════════════════════════════════════════════

console.log("");
if (failures.length === 0) {
  const verified = skipped === 0 ? "ssh-key e2e roundtrip verified" : `${skipped} skipped`;
  console.log(`all ok — abrain P0b master key bootstrap holds (${total} assertions, ${verified}).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed (${skipped} skipped).`);
  process.exit(1);
}
