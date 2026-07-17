#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0a — backend detection + sub-pi activate guard.
 *
 * v1.4 priority chain (vault-bootstrap.md §1.4):
 *
 *   1. $SECRETS_BACKEND env override
 *   2. ssh-key  (Tier 1 primary)
 *   3. gpg-file (Tier 1 primary)
 *   4. macos    (Tier 2 optimization)
 *   5. secret-service (Tier 2)
 *   6. pass     (Tier 2)
 *   7. passphrase-only (Tier 1 fallback — almost always selected if 2-6 fail)
 *   8. disabled (only via $SECRETS_BACKEND=disabled or ~/.abrain/.state/vault-disabled flag)
 *
 * Container scenario (alfadb main): ssh-key wins via path #2.
 *
 * Strategy: transpile the live TS sources and inject mocked deps.
 * No real subprocess spawns, no real fs reads.
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

function transpileTsToCjs(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(source, {
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

function loadModuleFromString(code, fakePath) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  m._compile(code, fakePath);
  return m.exports;
}

const detectSrc = path.join(repoRoot, "extensions/abrain/backend-detect.ts");
const detectCompiled = transpileTsToCjs(detectSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-abrain-"));
const detectModule = loadModuleFromString(
  detectCompiled,
  path.join(tmpDir, "backend-detect.cjs"),
);
const { detectBackend, formatStatus } = detectModule;

console.log("abrain backend detection — ADR 0019 (abrain self-managed vault identity)");

// ── Helper: build a deps object with sensible defaults ──────────
// Default = "headless container with nothing, no age-keygen installed" →
// should select disabled in ADR 0019 (no abrain-age-key prereq, no keychain).
// Set commandExists(c)=>c==="age-keygen" to simulate alfadb dev environment.
function deps(overrides = {}) {
  const base = {
    commandExists: () => false,
    fileExists: () => false,
    platform: "linux",
    home: "/home/test",
    env: {},
    gpgFirstSecretKey: () => null,
  };
  return { ...base, ...overrides, env: { ...base.env, ...(overrides.env || {}) } };
}

// ── 1. Tier 1 default: abrain-age-key (ADR 0019) ──────────────

check("abrain-age-key: identity secret already on disk → backend=abrain-age-key (initialized)", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.abrain/.vault-identity/master.age",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`expected abrain-age-key, got ${info.backend}`);
  if (info.identity !== "/home/test/.abrain/.vault-identity/master.age") throw new Error(`expected fixed identity path, got ${info.identity}`);
  if (!info.capabilities.autoUnlock) throw new Error("abrain-age-key reports autoUnlock=true (file 0600, no agent needed)");
  if (!info.reason.includes("already initialized")) throw new Error("reason should cite already initialized");
});

check("abrain-age-key: age-keygen on PATH (not yet initialized) → backend=abrain-age-key (init target)", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "age-keygen",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`expected abrain-age-key, got ${info.backend}`);
  if (info.identity) throw new Error("reason path expects identity unset until init runs");
  if (!info.reason.includes("age-keygen")) throw new Error("reason should cite age-keygen availability");
  if (!info.reason.includes("ADR 0019")) throw new Error("reason should reference ADR 0019");
});

check("abrain-age-key: identity file beats age-keygen-only (already-init wins over not-yet-init)", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.abrain/.vault-identity/master.age",
    commandExists: (c) => c === "age-keygen",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`expected abrain-age-key, got ${info.backend}`);
  if (!info.reason.includes("already initialized")) throw new Error("on-disk branch should fire first");
});

// ── 2. Tier 3 legacy backends NEVER auto-detect (ADR 0019) ────────────

check("ADR 0019: ssh-key is NO LONGER auto-detected (must be explicit)", () => {
  // Old v1.4: both id_ed25519 + .pub exist → backend=ssh-key auto.
  // ADR 0019: ssh keys ignored by detection; user must --backend=ssh-key explicitly.
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.ssh/id_ed25519" || p === "/home/test/.ssh/id_ed25519.pub",
  }));
  if (info.backend === "ssh-key") throw new Error("ADR 0019: ssh-key auto-detect must be removed");
  if (info.backend !== "disabled") throw new Error(`bare env should hit disabled, got ${info.backend}`);
});

check("ADR 0019: gpg-file is NO LONGER auto-detected (must be explicit)", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "gpg",
    gpgFirstSecretKey: () => "ABCD1234EF567890",
  }));
  if (info.backend === "gpg-file") throw new Error("ADR 0019: gpg-file auto-detect must be removed");
});

check("abrain-age-key wins over ssh keys on disk (ssh keys ignored entirely)", () => {
  // Even with full ssh keypair + age-keygen, detection picks abrain-age-key.
  const info = detectBackend(deps({
    fileExists: (p) => p.includes(".ssh/id_ed25519"),
    commandExists: (c) => c === "age-keygen",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`ADR 0019: abrain-age-key default; got ${info.backend}`);
});

// ── 3. Tier 2 keychain optimization paths ──────────────────────────────

check("macOS: platform=darwin + security cmd (no age-keygen) → backend=macos", () => {
  const info = detectBackend(deps({
    platform: "darwin",
    commandExists: (c) => c === "security",
  }));
  if (info.backend !== "macos") throw new Error(`expected macos, got ${info.backend}`);
  if (!info.capabilities.autoUnlock) throw new Error("macOS should report autoUnlock=true");
});

check("abrain-age-key beats macOS keychain when age-keygen is available", () => {
  // ADR 0019: Tier 1 > Tier 2. abrain-age-key covers cross-device uniformly;
  // keychain is session-local optimization, useful only when Tier 1 is missing.
  const info = detectBackend(deps({
    platform: "darwin",
    commandExists: (c) => c === "age-keygen" || c === "security",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`Tier 1 beats Tier 2 macos; got ${info.backend}`);
});

check("Linux + DISPLAY + secret-tool (no age-keygen) → backend=secret-service (Tier 2)", () => {
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("DISPLAY")) throw new Error("reason should cite DISPLAY");
});

check("Linux + WAYLAND_DISPLAY + secret-tool → secret-service cites WAYLAND", () => {
  const info = detectBackend(deps({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("WAYLAND_DISPLAY")) throw new Error("reason should cite WAYLAND_DISPLAY");
});

check("Linux desktop without secret-tool → falls through (CLI required)", () => {
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: () => false,
  }));
  if (info.backend === "secret-service") throw new Error("must not select secret-service without secret-tool");
});

check("pass + ~/.password-store/abrain (no age-keygen) → backend=pass (Tier 2)", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: (p) => p === "/home/test/.password-store/abrain",
  }));
  if (info.backend !== "pass") throw new Error(`expected pass, got ${info.backend}`);
  if (info.capabilities.autoUnlock) throw new Error("pass should report autoUnlock=false (manual gpg-agent)");
});

check("pass: cmd without password-store dir → falls through", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: () => false,
  }));
  if (info.backend === "pass") throw new Error("must require ~/.password-store/abrain/");
});

// ── 4. Tier 1 priority over Tier 2 (abrain-age-key vs keychain) ──────

check("priority: abrain-age-key beats secret-service when age-keygen available", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "age-keygen" || c === "secret-tool",
    env: { DISPLAY: ":0" },
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`Tier 1 beats Tier 2; got ${info.backend}`);
});

check("priority: abrain-age-key beats pass when age-keygen available", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "age-keygen" || c === "pass",
    fileExists: (p) => p === "/home/test/.password-store/abrain",
  }));
  if (info.backend !== "abrain-age-key") throw new Error(`Tier 1 beats Tier 2; got ${info.backend}`);
});

// ── 5. Tier 4 final: disabled (ADR 0019 — no more passphrase-only fallback) ──

check("ADR 0019: bare env (no age-keygen, no keychain) → disabled (NOT passphrase-only)", () => {
  // Big ADR 0019 change: auto-detect terminator is `disabled`, not `passphrase-only`.
  // passphrase-only had a reader-side gap (tty pass-through unimplemented), so
  // falling into it silently broke unlock. Now bare envs stay disabled and the
  // reason tells the user how to recover.
  const info = detectBackend(deps({}));
  if (info.backend !== "disabled") throw new Error(`ADR 0019: bare env should hit disabled, not ${info.backend}`);
  if (!info.reason.includes("age-keygen")) throw new Error("reason should hint installing age fixes this");
});

check("disabled reason: actionable error message references install hints", () => {
  const info = detectBackend(deps({}));
  if (!info.reason.match(/apt install|brew install/)) throw new Error("reason should suggest concrete install command");
  if (!info.reason.includes("Tier 3")) throw new Error("reason should mention Tier 3 explicit-backend escape hatch");
});

// ── 7. $SECRETS_BACKEND env override ────────────────────────────

check("$SECRETS_BACKEND=ssh-key forces ssh-key (overrides auto)", () => {
  const info = detectBackend(deps({
    env: { SECRETS_BACKEND: "ssh-key" },
    platform: "darwin", // would be macos under auto
  }));
  if (info.backend !== "env-override") throw new Error(`expected env-override, got ${info.backend}`);
  if (info.overrideTarget !== "ssh-key") throw new Error(`expected overrideTarget=ssh-key, got ${info.overrideTarget}`);
});

check("$SECRETS_BACKEND=passphrase-only is honored (explicit opt-in, despite reader gap)", () => {
  // Tier 3 explicit-only: user must knowingly opt in despite the reader
  // tty-pass-through gap (roadmap P0d). detectBackend still returns the
  // override; handleInit shows a stderr warning.
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "passphrase-only" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override`);
  if (info.overrideTarget !== "passphrase-only") throw new Error(`expected overrideTarget=passphrase-only`);
});

check("$SECRETS_BACKEND=abrain-age-key is honored (explicit pick of new default)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "abrain-age-key" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override`);
  if (info.overrideTarget !== "abrain-age-key") throw new Error(`expected overrideTarget=abrain-age-key`);
});

check("$SECRETS_BACKEND=disabled forces disabled (no overrideTarget)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "disabled" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override`);
  if (info.overrideTarget !== undefined) throw new Error(`disabled override should have no overrideTarget`);
});

check("$SECRETS_BACKEND=garbage falls through to auto-detect (security)", () => {
  // Critical: typo'd override must NOT silently do anything weird.
  // ADR 0019: fall-through in a bare env hits `disabled` (was passphrase-only).
  // With age-keygen available it would hit abrain-age-key — verify both branches.
  const info = detectBackend(deps({
    env: { SECRETS_BACKEND: "totally-fake-backend" },
  }));
  if (info.backend === "env-override") throw new Error("garbage override should NOT be honored");
  if (info.backend !== "disabled") throw new Error(`bare-env fall-through should hit disabled, got ${info.backend}`);

  const info2 = detectBackend(deps({
    env: { SECRETS_BACKEND: "totally-fake-backend" },
    commandExists: (c) => c === "age-keygen",
  }));
  if (info2.backend !== "abrain-age-key") throw new Error(`age-keygen-avail fall-through should hit abrain-age-key, got ${info2.backend}`);
});

check("$SECRETS_BACKEND case-insensitive (SSH-KEY honored)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "SSH-KEY" } }));
  if (info.backend !== "env-override") throw new Error("uppercase override should be honored");
  if (info.overrideTarget !== "ssh-key") throw new Error(`expected ssh-key, got ${info.overrideTarget}`);
});

// ── 8. formatStatus ─────────────────────────────────────────────

// ── State B: not initialized (initialized=null) ─────────────────

check("formatStatus B (not initialized, abrain-age-key detected): shows 'ready to init'", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "age-keygen",
  }));
  const out = formatStatus(info, false, null);
  if (!out.includes("not initialized")) throw new Error("output missing 'not initialized'");
  if (!out.includes("abrain-age-key")) throw new Error("output missing 'abrain-age-key'");
  if (!out.includes("to init:")) throw new Error("output missing 'to init:' hint");
});

check("formatStatus B (abrain-age-key, already initialized) shows fixed identity path", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.abrain/.vault-identity/master.age",
  }));
  const out = formatStatus(info, false, null);
  if (!out.includes("abrain-age-key")) throw new Error("output missing 'abrain-age-key'");
  if (!out.includes("/home/test/.abrain/.vault-identity/master.age")) throw new Error("output missing canonical identity path");
});

check("formatStatus B (bare env / disabled detected) renders disabled message", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, null);
  if (!out.includes("disabled") && !out.includes("no backend")) {
    throw new Error(`bare env should render disabled or no-backend message:\n${out}`);
  }
});

// ── State C: user-disabled flag set ─────────────────────────────

check("formatStatus C (vaultDisabledFlag=true, no init record) shows user-disabled state", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, true, null);
  if (!out.includes("disabled")) throw new Error("output missing 'disabled'");
  if (!out.includes("vault-disabled")) throw new Error("output missing path hint");
});

check("formatStatus C with init record: shows 'was initialized as'", () => {
  // edge case: user disabled vault AFTER initializing — make it explicit
  const info = detectBackend(deps({ fileExists: () => true }));
  const out = formatStatus(info, true, {
    backend: "ssh-key", identity: "/test", vaultMasterPresent: true,
  });
  if (!out.includes("was initialized as")) throw new Error("missing 'was initialized as'");
});

// ── State A: initialized (the dogfood-flagged case) ────────────────

check("★ formatStatus A (initialized): NO 'P0a' or 'P0b not delivered' wording", () => {
  // The dogfood discovery: previous status said 'P0a only detects' even after
  // user successfully ran /vault init. Verify we never regress to that wording.
  const info = detectBackend(deps({ fileExists: () => true }));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/home/worker/.ssh/id_rsa",
    publicKey: "age1zu6pzj7",
    vaultMasterPresent: true,
    vaultMasterMode: 0o600,
  });
  if (out.includes("P0a only detects")) throw new Error("REGRESSION: P0a wording in initialized status");
  if (out.includes("master key generation lands in P0b")) throw new Error("REGRESSION: 'P0b lands' wording");
  if (!out.includes("initialized")) throw new Error("missing 'initialized'");
  if (!out.includes("ssh-key")) throw new Error("missing backend");
  if (!out.includes("/home/worker/.ssh/id_rsa")) throw new Error("missing identity");
  if (!out.includes("age1zu6pzj7")) throw new Error("missing public key");
});

check("formatStatus A with file backend missing master file: warns inconsistent", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/x",
    vaultMasterPresent: false, // ← simulates corrupted state
  });
  if (!out.includes("MISSING")) throw new Error("missing 'MISSING' warning");
  if (!out.includes("inconsistent")) throw new Error("missing 'inconsistent' warning");
});

check("formatStatus A with permissive .vault-master.age mode: warns group/other readable", () => {
  // Regression for the dogfood-flagged 0664 issue (v1.4.1 fix): if for some
  // reason a future bug puts .vault-master.age back at 0664, status surfaces it.
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/x",
    vaultMasterPresent: true,
    vaultMasterMode: 0o664,
  });
  if (!out.includes("⚠")) throw new Error("missing warning marker for permissive mode");
  if (!out.includes("group/other readable")) throw new Error("missing mode warning text");
});

check("formatStatus A with keychain backend: shows 'master stored in: macOS Keychain'", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "macos",
    vaultMasterPresent: false, // keychain backends don't write file
  });
  if (out.includes("MISSING")) throw new Error("keychain backend should NOT trigger MISSING warning");
  if (!out.includes("master stored in:")) throw new Error("missing 'master stored in:' line");
  if (!out.includes("macOS Keychain")) throw new Error("missing 'macOS Keychain' description");
});

check("formatStatus A states shipped P0c read/write + project routing", () => {
  // Verify status text does not mislead users: /secret write/list/forget,
  // vault_release, bash injection, and project vault routing are shipped.
  // B4.5 further tightens project routing with strict binding, but routing
  // itself is no longer pending.
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key", identity: "/x", vaultMasterPresent: true, vaultMasterMode: 0o600,
  });
  if (!out.includes("P0c.write / P0c.read / vault_release LLM tool / $VAULT_* bash injection / project vault routing all implemented")) {
    throw new Error(`missing shipped P0c/project routing note:\n${out}`);
  }
  if (out.includes("remains pending")) throw new Error("stale pending project routing wording leaked");
  if (out.includes("cannot write")) throw new Error("stale cannot-write wording leaked");
});

// ── 9. activate() respects PI_ABRAIN_DISABLED=1 ─────────────────
//
// Same as before — sub-pi guard still in place.

const detectFile = path.join(tmpDir, "backend-detect.cjs");
fs.writeFileSync(detectFile, detectCompiled);
// ADR 0019: keychain.ts and vault-reader.ts now import from ./backend-detect.
// Provide an extensionless .js companion so their compiled CJS can resolve
// the relative require (./backend-detect → backend-detect.js in tmpDir).
fs.copyFileSync(detectFile, path.join(tmpDir, "backend-detect.js"));

// index.ts imports ./bootstrap, ./keychain, ./vault-writer, ./vault-reader.
// Relative imports must be rewritten to .cjs paths so the transpiled CJS
// module can resolve them in the smoke tmp dir.
const bootstrapSrc = path.join(repoRoot, "extensions/abrain/bootstrap.ts");
const keychainSrc = path.join(repoRoot, "extensions/abrain/keychain.ts");
const vaultWriterSrc = path.join(repoRoot, "extensions/abrain/vault-writer.ts");
const vaultReaderSrc = path.join(repoRoot, "extensions/abrain/vault-reader.ts");
const vaultBashSrc = path.join(repoRoot, "extensions/abrain/vault-bash.ts");
const brainLayoutSrc = path.join(repoRoot, "extensions/abrain/brain-layout.ts");
const ruleInjectorSrc = path.join(repoRoot, "extensions/abrain/rule-injector/index.ts");
const ruleInjectorDualReadAuditSrc = path.join(repoRoot, "extensions/abrain/rule-injector/dualread-audit.ts");
const ruleInjectorStableViewReaderSrc = path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts");
const ruleInjectorStableViewRuntimeAuditSrc = path.join(repoRoot, "extensions/abrain/rule-injector/proposition-policy-stable-view-runtime-audit.ts");
fs.writeFileSync(path.join(tmpDir, "bootstrap.cjs"), transpileTsToCjs(bootstrapSrc));
fs.writeFileSync(path.join(tmpDir, "keychain.cjs"), transpileTsToCjs(keychainSrc));
fs.writeFileSync(path.join(tmpDir, "vault-writer.cjs"), transpileTsToCjs(vaultWriterSrc));
fs.writeFileSync(path.join(tmpDir, "vault-reader.cjs"), transpileTsToCjs(vaultReaderSrc));
fs.writeFileSync(path.join(tmpDir, "vault-bash.cjs"), transpileTsToCjs(vaultBashSrc));
// brain-layout.ts now imports `../_shared/runtime` (P1-2 audit fix 2026-05-16
// round 4: computeAbrainStateGitignoreNext helper). Mirror the same
// require-path rewrite we apply to index.ts so brain-layout.cjs can
// resolve the shared helper from `<tmpDir>/_shared/runtime.cjs`.
fs.writeFileSync(
  path.join(tmpDir, "brain-layout.cjs"),
  transpileTsToCjs(brainLayoutSrc).replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")'),
);
fs.writeFileSync(
  path.join(tmpDir, "i18n.cjs"),
  transpileTsToCjs(path.join(repoRoot, "extensions/abrain/i18n.ts"))
    .replace(/require\("\.\.\/_shared\/llm-audit"\)/g, 'require("./_shared/llm-audit.cjs")'),
);
fs.writeFileSync(path.join(tmpDir, "reconcile-gate.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/abrain/reconcile-gate.ts")));
fs.writeFileSync(
  path.join(tmpDir, "git-sync.cjs"),
  transpileTsToCjs(path.join(repoRoot, "extensions/abrain/git-sync.ts"))
    .replace(/require\("\.\.\/_shared\/causal-anchor"\)/g, 'require("./_shared/causal-anchor.cjs")')
    .replace(/require\("\.\.\/_shared\/git-singleflight"\)/g, 'require("./_shared/git-singleflight.cjs")'),
);
// ADR 0022 P3b: index.ts imports ./vault-authorize for PromptDialog overlay
// path. Stage the transpiled module alongside the other abrain helpers.
fs.writeFileSync(
  path.join(tmpDir, "vault-authorize.cjs"),
  transpileTsToCjs(path.join(repoRoot, "extensions/abrain/vault-authorize.ts")),
);
fs.copyFileSync(path.join(tmpDir, "vault-authorize.cjs"), path.join(tmpDir, "vault-authorize.js"));
// ADR 0022 P1: git-sync.ts now re-exports redactCredentials from ./redact.
// transpile + extensionless .js alias so CJS `require("./redact")` resolves.
fs.writeFileSync(path.join(tmpDir, "redact.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/abrain/redact.ts")));
// vault-reader.cjs keeps its own relative imports (./keychain, ./vault-writer),
// so provide extensionless .js companions in the tmp dir as well.
fs.copyFileSync(path.join(tmpDir, "keychain.cjs"), path.join(tmpDir, "keychain.js"));
fs.copyFileSync(path.join(tmpDir, "vault-writer.cjs"), path.join(tmpDir, "vault-writer.js"));
fs.copyFileSync(path.join(tmpDir, "vault-reader.cjs"), path.join(tmpDir, "vault-reader.js"));
fs.copyFileSync(path.join(tmpDir, "brain-layout.cjs"), path.join(tmpDir, "brain-layout.js"));
fs.copyFileSync(path.join(tmpDir, "git-sync.cjs"), path.join(tmpDir, "git-sync.js"));
fs.copyFileSync(path.join(tmpDir, "reconcile-gate.cjs"), path.join(tmpDir, "reconcile-gate.js"));
fs.copyFileSync(path.join(tmpDir, "redact.cjs"), path.join(tmpDir, "redact.js"));
// ADR 0023-R5: abrain/index.ts imports ./rule-injector. Stage the leaf
// module and its extensionless shim; relative imports are rewritten below
// after _shared + memory helper modules are staged.
fs.mkdirSync(path.join(tmpDir, "rule-injector"), { recursive: true });
// ADR 0022 P2: abrain/index.ts activate() lazy-requires the prompt-user
// subtree when toolRegistry.registerTool is present. Mirror the layout.
const promptUserDir = path.join(tmpDir, "prompt-user");
const promptUserUiDir = path.join(promptUserDir, "ui");
fs.mkdirSync(promptUserUiDir, { recursive: true });
for (const m of ["types", "schema", "manager", "service", "handler"]) {
  const cjsPath = path.join(promptUserDir, `${m}.cjs`);
  fs.writeFileSync(cjsPath, transpileTsToCjs(path.join(repoRoot, "extensions/abrain/prompt-user", `${m}.ts`)));
  fs.copyFileSync(cjsPath, path.join(promptUserDir, `${m}.js`));
}
const dialogCjs = path.join(promptUserUiDir, "PromptDialog.cjs");
fs.writeFileSync(dialogCjs, transpileTsToCjs(path.join(repoRoot, "extensions/abrain/prompt-user/ui/PromptDialog.ts")));
fs.copyFileSync(dialogCjs, path.join(promptUserUiDir, "PromptDialog.js"));
// _shared/runtime is required by index.ts via ../_shared/runtime; mirror that layout.
const sharedTargetDir = path.join(tmpDir, "_shared");
fs.mkdirSync(sharedTargetDir, { recursive: true });
fs.writeFileSync(path.join(sharedTargetDir, "runtime.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/_shared/runtime.ts")));
fs.copyFileSync(path.join(sharedTargetDir, "runtime.cjs"), path.join(sharedTargetDir, "runtime.js"));
for (const moduleName of ["jcs", "proposition-policy-stable-view-contract"]) {
  const cjsPath = path.join(sharedTargetDir, `${moduleName}.cjs`);
  fs.writeFileSync(cjsPath, transpileTsToCjs(path.join(repoRoot, "extensions/_shared", `${moduleName}.ts`)));
  fs.copyFileSync(cjsPath, path.join(sharedTargetDir, `${moduleName}.js`));
}
fs.writeFileSync(path.join(sharedTargetDir, "git-singleflight.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/_shared/git-singleflight.ts")));
fs.copyFileSync(path.join(sharedTargetDir, "git-singleflight.cjs"), path.join(sharedTargetDir, "git-singleflight.js"));
fs.writeFileSync(path.join(sharedTargetDir, "causal-anchor.cjs"), `module.exports = { getCurrentAnchor: () => undefined, spreadAnchor: () => ({}) };\n`);
fs.copyFileSync(path.join(sharedTargetDir, "causal-anchor.cjs"), path.join(sharedTargetDir, "causal-anchor.js"));
fs.writeFileSync(
  path.join(sharedTargetDir, "pi-internals.cjs"),
  `exports.isSubAgentSession = function isSubAgentSession(ctx) { return !!(ctx && ctx.sessionManager && ctx.sessionManager.__piAstackSubAgent === true); };\n`,
);
fs.copyFileSync(path.join(sharedTargetDir, "pi-internals.cjs"), path.join(sharedTargetDir, "pi-internals.js"));
fs.writeFileSync(
  path.join(sharedTargetDir, "llm-audit.cjs"),
  `exports.auditStreamSimple = function auditStreamSimple() {};\n`,
);
fs.copyFileSync(path.join(sharedTargetDir, "llm-audit.cjs"), path.join(sharedTargetDir, "llm-audit.js"));
const sedimentTargetDir = path.join(tmpDir, "sediment");
fs.mkdirSync(sedimentTargetDir, { recursive: true });
fs.writeFileSync(
  path.join(sedimentTargetDir, "settings.cjs"),
  `exports.resolveSedimentSettings = function resolveSedimentSettings() { return { knowledgeProjector: { canonicalReadMode: "legacy" } }; };\n`,
);
fs.copyFileSync(path.join(sedimentTargetDir, "settings.cjs"), path.join(sedimentTargetDir, "settings.js"));
fs.writeFileSync(
  path.join(sedimentTargetDir, "knowledge-evidence.cjs"),
  `exports.readKnowledgeProjectionStores = function readKnowledgeProjectionStores() { return []; };\nexports.readKnowledgeStableViewStores = function readKnowledgeStableViewStores() { return []; };\n`,
);
fs.copyFileSync(path.join(sedimentTargetDir, "knowledge-evidence.cjs"), path.join(sedimentTargetDir, "knowledge-evidence.js"));
const memoryTargetDir = path.join(tmpDir, "memory");
fs.mkdirSync(memoryTargetDir, { recursive: true });
// ADR 0034 P1: parser.ts now imports ./direction-impact (parseDirectionImpact).
// Stage it alongside the other memory helpers so the transpiled require resolves.
for (const m of ["parser", "utils", "settings", "direction-impact"]) {
  const cjsPath = path.join(memoryTargetDir, `${m}.cjs`);
  fs.writeFileSync(cjsPath, transpileTsToCjs(path.join(repoRoot, "extensions/memory", `${m}.ts`)));
  fs.copyFileSync(cjsPath, path.join(memoryTargetDir, `${m}.js`));
}
const footerStatusPath = path.join(sharedTargetDir, "footer-status.cjs");
fs.writeFileSync(footerStatusPath, transpileTsToCjs(path.join(repoRoot, "extensions/_shared/footer-status.ts")));
fs.copyFileSync(footerStatusPath, path.join(sharedTargetDir, "footer-status.js"));
const ruleInjectorDualReadAuditCompiled = transpileTsToCjs(ruleInjectorDualReadAuditSrc);
fs.writeFileSync(path.join(tmpDir, "rule-injector", "dualread-audit.cjs"), ruleInjectorDualReadAuditCompiled);
fs.copyFileSync(path.join(tmpDir, "rule-injector", "dualread-audit.cjs"), path.join(tmpDir, "rule-injector", "dualread-audit.js"));
const ruleInjectorStableViewReaderCompiled = transpileTsToCjs(ruleInjectorStableViewReaderSrc)
  .replace(/require\("\.\.\/\.\.\/_shared\/proposition-policy-stable-view-contract"\)/g, 'require("../_shared/proposition-policy-stable-view-contract.cjs")');
fs.writeFileSync(path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-reader.cjs"), ruleInjectorStableViewReaderCompiled);
fs.copyFileSync(path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-reader.cjs"), path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-reader.js"));
const ruleInjectorStableViewRuntimeAuditCompiled = transpileTsToCjs(ruleInjectorStableViewRuntimeAuditSrc)
  .replace(/require\("\.\.\/\.\.\/_shared\/jcs"\)/g, 'require("../_shared/jcs.cjs")')
  .replace(/require\("\.\/proposition-policy-stable-view-reader"\)/g, 'require("./proposition-policy-stable-view-reader.cjs")');
fs.writeFileSync(path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-runtime-audit.cjs"), ruleInjectorStableViewRuntimeAuditCompiled);
fs.copyFileSync(path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-runtime-audit.cjs"), path.join(tmpDir, "rule-injector", "proposition-policy-stable-view-runtime-audit.js"));
let ruleInjectorCompiled = transpileTsToCjs(ruleInjectorSrc)
  .replace(/require\("\.\.\/\.\.\/_shared\/footer-status"\)/g, 'require("../_shared/footer-status.cjs")')
  .replace(/require\("\.\.\/\.\.\/_shared\/runtime"\)/g, 'require("../_shared/runtime.cjs")')
  .replace(/require\("\.\.\/\.\.\/_shared\/pi-internals"\)/g, 'require("../_shared/pi-internals.cjs")')
  .replace(/require\("\.\.\/\.\.\/memory\/parser"\)/g, 'require("../memory/parser.cjs")')
  .replace(/require\("\.\.\/\.\.\/memory\/utils"\)/g, 'require("../memory/utils.cjs")')
  .replace(/require\("\.\/dualread-audit"\)/g, 'require("./dualread-audit.cjs")')
  .replace(/require\("\.\/proposition-policy-stable-view-reader"\)/g, 'require("./proposition-policy-stable-view-reader.cjs")')
  .replace(/require\("\.\/proposition-policy-stable-view-runtime-audit"\)/g, 'require("./proposition-policy-stable-view-runtime-audit.cjs")');
fs.writeFileSync(path.join(tmpDir, "rule-injector", "index.cjs"), ruleInjectorCompiled);
fs.copyFileSync(path.join(tmpDir, "rule-injector", "index.cjs"), path.join(tmpDir, "rule-injector", "index.js"));
fs.writeFileSync(path.join(tmpDir, "rule-injector.js"), 'module.exports = require("./rule-injector/index.cjs");\n');

const indexSrc = path.join(repoRoot, "extensions/abrain/index.ts");
let indexCompiled = transpileTsToCjs(indexSrc);
indexCompiled = indexCompiled
  .replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")')
  .replace(/require\("\.\/bootstrap"\)/g, 'require("./bootstrap.cjs")')
  .replace(/require\("\.\/keychain"\)/g, 'require("./keychain.cjs")')
  .replace(/require\("\.\/vault-writer"\)/g, 'require("./vault-writer.cjs")')
  .replace(/require\("\.\/vault-reader"\)/g, 'require("./vault-reader.cjs")')
  .replace(/require\("\.\/vault-bash"\)/g, 'require("./vault-bash.cjs")')
  .replace(/require\("\.\/i18n"\)/g, 'require("./i18n.cjs")')
  .replace(/require\("\.\/brain-layout"\)/g, 'require("./brain-layout.cjs")')
  .replace(/require\("\.\/git-sync"\)/g, 'require("./git-sync.cjs")')
  .replace(/require\("\.\/vault-authorize"\)/g, 'require("./vault-authorize.cjs")')
  .replace(/require\("\.\/rule-injector"\)/g, 'require("./rule-injector/index.cjs")')
  .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")')
  .replace(/require\("\.\.\/_shared\/git-singleflight"\)/g, 'require("./_shared/git-singleflight.cjs")')
  .replace(/require\("\.\.\/_shared\/pi-internals"\)/g, 'require("./_shared/pi-internals.cjs")');
const indexFile = path.join(tmpDir, "index.cjs");
fs.writeFileSync(indexFile, indexCompiled);
const indexModule = require(indexFile);
const activate = indexModule.default;

check("activate is a function", () => {
  if (typeof activate !== "function") throw new Error(`expected function, got ${typeof activate}`);
});

check("startup git sync fetched updates schedule constraint shadow auto-refresh", async () => {
  const calls = [];
  const modelRegistry = { find() {}, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x" }) };
  const result = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
    { result: "ok", merged: 2 },
    {
      abrainHome: "/tmp/abrain-smoke",
      cwd: "/tmp/project-smoke",
      activeProject: { activeProject: { projectId: "proj-main" } },
      modelRegistry,
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: true } } }),
      listProjectIds: () => ["proj-z", "proj-main"],
      schedule: (trigger) => { calls.push(trigger); return { scheduled: true, reason: "scheduled_now" }; },
    },
  );
  if (!result.scheduled || result.reason !== "scheduled_now") throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  if (calls.length !== 1) throw new Error(`expected one schedule call, got ${calls.length}`);
  const trigger = calls[0];
  if (trigger.reason !== "git_sync_fetched") throw new Error(`wrong reason: ${trigger.reason}`);
  if (trigger.sourceEventId !== undefined) throw new Error(`sourceEventId should be undefined: ${trigger.sourceEventId}`);
  if (trigger.activeProjectId !== "proj-main") throw new Error(`wrong activeProjectId: ${trigger.activeProjectId}`);
  if (trigger.cwd !== "/tmp/project-smoke") throw new Error(`wrong cwd: ${trigger.cwd}`);
  if (trigger.modelRegistry !== modelRegistry) throw new Error("modelRegistry was not forwarded by identity");
  if (JSON.stringify(trigger.knownProjectIds) !== JSON.stringify(["proj-main", "proj-z"])) throw new Error(`wrong knownProjectIds: ${JSON.stringify(trigger.knownProjectIds)}`);
});

check("startup git sync with no fetched updates does NOT schedule constraint shadow auto-refresh", async () => {
  let calls = 0;
  const result = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
    { result: "ok", merged: 0, behind: 0 },
    {
      modelRegistry: { find() {}, getApiKeyAndHeaders: async () => ({ ok: true }) },
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: true } } }),
      schedule: () => { calls += 1; return { scheduled: true, reason: "bad" }; },
    },
  );
  if (calls !== 0) throw new Error(`schedule called ${calls} time(s)`);
  if (result.scheduled || result.reason !== "git_sync_no_fetched_updates") throw new Error(`unexpected result: ${JSON.stringify(result)}`);
});

check("startup git sync failure/conflict does NOT schedule constraint shadow auto-refresh", async () => {
  for (const event of [{ result: "failed", merged: 1 }, { result: "timeout", merged: 1 }, { result: "diverged", merged: 1 }]) {
    let calls = 0;
    const result = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(event, {
      modelRegistry: { find() {}, getApiKeyAndHeaders: async () => ({ ok: true }) },
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: true } } }),
      schedule: () => { calls += 1; return { scheduled: true, reason: "bad" }; },
    });
    if (calls !== 0) throw new Error(`schedule called for ${event.result}`);
    if (result.scheduled || result.reason !== "git_sync_no_fetched_updates") throw new Error(`unexpected result for ${event.result}: ${JSON.stringify(result)}`);
  }
});

check("startup git sync fetched updates respect constraint shadow gates and missing modelRegistry", async () => {
  let calls = 0;
  const disabled = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
    { result: "ok", merged: 1 },
    {
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: false, autoRefresh: { enabled: true } } }),
      schedule: () => { calls += 1; return { scheduled: true, reason: "bad" }; },
    },
  );
  if (disabled.scheduled || disabled.reason !== "constraint_shadow_compiler_disabled") throw new Error(`unexpected disabled result: ${JSON.stringify(disabled)}`);

  const autoDisabled = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
    { result: "ok", merged: 1 },
    {
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: false } } }),
      schedule: () => { calls += 1; return { scheduled: true, reason: "bad" }; },
    },
  );
  if (autoDisabled.scheduled || autoDisabled.reason !== "auto_refresh_disabled") throw new Error(`unexpected auto-disabled result: ${JSON.stringify(autoDisabled)}`);

  const notices = [];
  const missingRegistry = await indexModule.maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
    { result: "ok", merged: 1 },
    {
      resolveSettings: () => ({ constraintShadowCompiler: { enabled: true, autoRefresh: { enabled: true } } }),
      notify: (msg, type) => notices.push({ msg, type }),
      schedule: () => { calls += 1; return { scheduled: true, reason: "bad" }; },
    },
  );
  if (missingRegistry.scheduled || missingRegistry.reason !== "model_registry_unavailable") throw new Error(`unexpected missing-registry result: ${JSON.stringify(missingRegistry)}`);
  if (notices.length !== 1 || !notices[0].msg.includes("model registry unavailable") || notices[0].type !== "warning") throw new Error(`missing observable notice: ${JSON.stringify(notices)}`);
  if (calls !== 0) throw new Error(`schedule should not have been called, got ${calls}`);
});

check("PI_ABRAIN_DISABLED=1 → activate registers ZERO commands (sub-pi guard)", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  try {
    let registerCalls = 0;
    let toolCalls = 0;
    let eventCalls = 0;
    activate({ registerCommand: () => { registerCalls += 1; }, registerTool: () => { toolCalls += 1; }, on: () => { eventCalls += 1; } });
    if (registerCalls !== 0) throw new Error(`sub-pi guard breached: registerCommand called ${registerCalls} time(s)`);
    if (toolCalls !== 0) throw new Error(`sub-pi guard breached: registerTool called ${toolCalls} time(s)`);
    if (eventCalls !== 0) throw new Error(`sub-pi guard breached: event handler registered ${eventCalls} time(s)`);
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED unset → activate registers /vault, vault_release, and bash vault hooks", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    const registered = [];
    const tools = [];
    const events = [];
    const toolDefs = [];
    activate({ registerCommand: (name) => registered.push(name), registerTool: (tool) => { tools.push(tool.name); toolDefs.push(tool); }, on: (event) => events.push(event) });
    if (!registered.includes("vault")) throw new Error(`expected /vault, got: ${registered.join(", ")}`);
    if (!tools.includes("vault_release")) throw new Error(`expected vault_release tool, got: ${tools.join(", ")}`);
    if (!events.includes("tool_call") || !events.includes("tool_result")) throw new Error(`expected bash vault hooks, got: ${events.join(", ")}`);
    if (!events.includes("message_start")) throw new Error(`expected message_start hook for i18n language tracking, got: ${events.join(", ")}`);
    const release = toolDefs.find((t) => t.name === "vault_release");
    if (!release || !release.parameters || !release.parameters.properties) throw new Error("vault_release tool definition missing parameters.properties");
    if (!release.parameters.properties.scope) throw new Error("vault_release schema must declare top-level scope (LLMs cannot reliably emit nested options object)");
    if (!release.parameters.properties.reason) throw new Error("vault_release schema must declare top-level reason");
    if (release.parameters.properties.options) throw new Error("vault_release schema should not declare nested options (callers must use flat scope/reason)");
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED=0 → activate DOES register (only literal '1' disables)", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "0";
  try {
    let registerCalls = 0;
    activate({ registerCommand: () => { registerCalls += 1; } });
    if (registerCalls === 0) throw new Error("only literal '1' should disable");
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("activate handles missing registerCommand gracefully", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    activate({}); // no registerCommand at all
  } catch (err) {
    throw new Error(`activate threw: ${err.message}`);
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("authorization prompt titles disclose key + scope + reason + description (so the user knows what they're approving)", () => {
  // formatReleaseAuthorizationTitle: scope:key + LLM reason + description + plaintext warning.
  const releaseTitle = indexModule.formatReleaseAuthorizationTitle("global", "github-token", "push to main", "GitHub PAT for the release pipeline");
  if (!releaseTitle.includes("global:github-token")) throw new Error(`release title missing scope:key — ${releaseTitle}`);
  if (!releaseTitle.includes("push to main")) throw new Error(`release title missing LLM reason — ${releaseTitle}`);
  if (!releaseTitle.includes("GitHub PAT for the release pipeline")) throw new Error(`release title missing description — ${releaseTitle}`);
  if (!releaseTitle.toLowerCase().includes("plaintext")) throw new Error(`release title missing plaintext warning — ${releaseTitle}`);
  // Description omitted: prompt still renders without a phantom line.
  const noDescTitle = indexModule.formatReleaseAuthorizationTitle("global", "github-token", "reason", undefined);
  if (noDescTitle.includes("description:")) throw new Error(`should omit description line when none — ${noDescTitle}`);
  // No LLM reason supplied: prompt annotates that explicitly.
  const noReasonTitle = indexModule.formatReleaseAuthorizationTitle({ project: "pi-global" }, "db-password", undefined);
  if (!noReasonTitle.includes("project:pi-global:db-password")) throw new Error(`project scope label missing — ${noReasonTitle}`);
  if (!noReasonTitle.toLowerCase().includes("none supplied")) throw new Error(`missing fallback reason annotation — ${noReasonTitle}`);

  // formatBashAuthorizationTitle: keys list (with optional per-key description) + command preview.
  const descriptions = new Map([
    ["global:github-token", "GitHub PAT for the release pipeline"],
  ]);
  const bashTitle = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "github-token", value: "<x>", placeholder: "<vault:global:github-token>" }],
    originalCommand: "curl -H \"Authorization: token $VAULT_github_token\" https://api.github.com/user",
  }, descriptions);
  if (!bashTitle.includes("global:github-token")) throw new Error(`bash title missing keys — ${bashTitle}`);
  if (!bashTitle.includes("GitHub PAT for the release pipeline")) throw new Error(`bash title missing description — ${bashTitle}`);
  if (!bashTitle.includes("curl -H")) throw new Error(`bash title missing command preview — ${bashTitle}`);
  if (!bashTitle.toLowerCase().includes("encoded")) throw new Error(`bash title missing encoded-secret warning — ${bashTitle}`);
  // Without descriptions, the keys line still renders cleanly.
  const bashTitleNoDesc = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "github-token", value: "<x>", placeholder: "<vault:global:github-token>" }],
    originalCommand: "echo ok",
  });
  if (!bashTitleNoDesc.includes("global:github-token")) throw new Error(`bash title (no descriptions) missing key — ${bashTitleNoDesc}`);
  if (bashTitleNoDesc.includes(" — ")) throw new Error(`bash title should not render empty description dash — ${bashTitleNoDesc}`);

  // Very long values should be truncated so the prompt stays usable.
  const longCmd = "echo " + "x".repeat(2000) + " tail-marker";
  const truncated = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "k", value: "v", placeholder: "<vault:global:k>" }],
    originalCommand: longCmd,
  });
  if (truncated.length > 1000) throw new Error(`bash title not truncated, length=${truncated.length}`);
  if (!truncated.includes("tail-marker")) throw new Error(`truncation should keep tail (last meaningful chars)`);
});

check("vault_release / bash hook write read-path audit ops via appendVaultReadAudit", () => {
  // Static contract: source code must wire the audit helpers into both the
  // vault_release tool execute() path AND the bash tool_call / tool_result
  // hooks, so the read-path audit story stays plumbed through future
  // refactors. (Live audit writes are exercised via smoke-abrain-vault-writer.)
  const src = fs.readFileSync(indexSrc, "utf8");
  for (const symbol of [
    "appendVaultReadAudit",
    "auditReleaseDecision",
    "auditBashInject",
    "auditBashInjectBlock",
    "auditBashOutput",
  ]) {
    if (!src.includes(symbol)) throw new Error(`audit wiring missing symbol: ${symbol}`);
  }
  for (const op of [
    'auditReleaseDecision("release_blocked"',
    'auditReleaseDecision("release_denied"',
    'auditReleaseDecision("release"',
    'auditBashInjectBlock(',
    'auditBashInject(',
    'auditBashOutput("bash_output_release"',
    'auditBashOutput("bash_output_withhold"',
  ]) {
    if (!src.includes(op)) throw new Error(`audit callsite missing: ${op}`);
  }
});

check("vault_release pre-flight existence check runs BEFORE user authorization (no phantom prompts)", () => {
  const src = fs.readFileSync(indexSrc, "utf8");
  if (!src.includes("checkedBeforeAuthorization")) throw new Error("pre-flight branch missing — vault_release would prompt for nonexistent keys");
  if (!src.includes("vaultFilePath(ABRAIN_HOME, scope, key)")) throw new Error("vault_release must consult vaultFilePath() pre-flight");
  const preFlightIdx = src.indexOf("checkedBeforeAuthorization");
  const authorizeIdx = src.indexOf("authorizeVaultRelease(ctx.ui");
  if (preFlightIdx < 0 || authorizeIdx < 0 || preFlightIdx >= authorizeIdx) {
    throw new Error("pre-flight must precede authorizeVaultRelease() in execute() to avoid phantom prompts");
  }
});

check("vault authorization menus are default-deny for non-interactive runners", () => {
  const src = fs.readFileSync(indexSrc, "utf8");
  if (!indexModule.VAULT_RELEASE_AUTH_CHOICES || indexModule.VAULT_RELEASE_AUTH_CHOICES[0] !== "No") throw new Error("vault_release authorization should put No first");
  const vaultBash = require(path.join(tmpDir, "vault-bash.cjs"));
  if (!vaultBash.VAULT_BASH_OUTPUT_AUTH_CHOICES || vaultBash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0] !== "No") throw new Error("bash output authorization should put No first");
});

// ── Done ────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain v1.4 backend detection + sub-pi guard hold (${totalChecks} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${totalChecks} assertions failed.`);
  process.exit(1);
}
