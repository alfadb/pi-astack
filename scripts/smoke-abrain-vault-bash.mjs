#!/usr/bin/env node
/**
 * Smoke test: abrain P0c.read — vault-backed bash injection helpers.
 *
 * Library-level coverage (no real age unlock). Verifies:
 *   - $VAULT_/$GVAULT_/$PVAULT_ parsing
 *   - boot-aware scope routing per ADR 0014 P1 step 3:
 *       $VAULT_   → active project first, fall back to global
 *       $GVAULT_  → global only
 *       $PVAULT_  → active project only (blocked when no project bound)
 *   - 0600 temp env-file creation + command rewrite without plaintext argv
 *   - default withheld output payload + literal redaction
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-bash-"));
const moduleDir = path.join(tmpDir, "abrain");
const sharedDir = path.join(tmpDir, "_shared");
fs.mkdirSync(moduleDir, { recursive: true });
fs.mkdirSync(sharedDir, { recursive: true });
fs.writeFileSync(
  path.join(sharedDir, "causal-anchor.js"),
  "exports.getCurrentAnchor = () => undefined;\nexports.spreadAnchor = () => ({});\n",
);
fs.writeFileSync(
  path.join(sharedDir, "runtime.js"),
  "exports.computeAbrainStateGitignoreNext = (raw) => /(^|\\n)\\.state\\/?(\\n|$)/.test(raw) ? null : `${raw}${raw && !raw.endsWith('\\n') ? '\\n' : ''}.state/\\n`;\n",
);
// ADR 0019: vault-reader.ts + keychain.ts now import from ./backend-detect.
for (const file of ["backend-detect", "vault-bash", "vault-reader", "vault-writer", "keychain"]) {
  fs.writeFileSync(path.join(moduleDir, `${file}.cjs`), transpile(path.join(repoRoot, "extensions", "abrain", `${file}.ts`)));
  fs.copyFileSync(path.join(moduleDir, `${file}.cjs`), path.join(moduleDir, `${file}.js`));
}

const bash = require(path.join(moduleDir, "vault-bash.cjs"));

console.log("abrain P0c.read — vault-backed bash helper");

const release = {
  scope: "global",
  key: "api-key",
  value: "secret-VALUE-123",
  placeholder: "<vault:global:api-key>",
};

await check("vaultVarRefs parses bare/braced VAULT and GVAULT refs", () => {
  const refs = bash.vaultVarRefs("echo $VAULT_api_key ${GVAULT_API_KEY} $PVAULT_local $NOT_VAULT");
  for (const expected of ["VAULT_api_key", "GVAULT_API_KEY", "PVAULT_local"]) {
    if (!refs.includes(expected)) throw new Error(`missing ${expected}: ${refs.join(",")}`);
  }
  if (refs.includes("NOT_VAULT")) throw new Error("matched non-vault variable");
});

await check("vaultVarPrefix classifies prefix correctly", () => {
  if (bash.vaultVarPrefix("VAULT_x") !== "VAULT_") throw new Error("VAULT_");
  if (bash.vaultVarPrefix("GVAULT_x") !== "GVAULT_") throw new Error("GVAULT_");
  if (bash.vaultVarPrefix("PVAULT_x") !== "PVAULT_") throw new Error("PVAULT_");
  if (bash.vaultVarPrefix("OTHER_x") !== null) throw new Error("non-vault must be null");
});

await check("keyCandidatesFromVaultVar maps underscores to dash fallback", () => {
  const candidates = bash.keyCandidatesFromVaultVar("VAULT_GitHub_Token");
  for (const expected of ["GitHub_Token", "GitHub-Token", "github_token", "github-token"]) {
    if (!candidates.includes(expected)) throw new Error(`missing ${expected}: ${candidates.join(",")}`);
  }
});

await check("prepareVaultBashCommand returns none when command has no vault refs", async () => {
  const result = await bash.prepareVaultBashCommand("echo plain", {
    keyForVar: () => { throw new Error("should not resolve key"); },
    releaseKey: async () => { throw new Error("should not release"); },
    writeEnvFile: () => { throw new Error("should not write env file"); },
  });
  if (result.kind !== "none") throw new Error(`expected none, got ${result.kind}`);
});

await check("prepareVaultBashCommand surfaces pvaultBlockReason when no project bound", async () => {
  const result = await bash.prepareVaultBashCommand("echo $PVAULT_api_key", {
    keyForVar: () => undefined,
    releaseKey: async () => release,
    writeEnvFile: () => "/tmp/unused",
    pvaultBlockReason: "$PVAULT_* requires an active project; current cwd is not bound to one.",
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("active project")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("prepareVaultBashCommand blocks missing key with where-to-look hint", async () => {
  const result = await bash.prepareVaultBashCommand("echo $VAULT_missing_key", {
    keyForVar: () => undefined,
    releaseKey: async () => release,
    writeEnvFile: () => "/tmp/unused",
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("active project or global vault")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("prepareVaultBashCommand rewrites command without plaintext in argv", async () => {
  let capturedVars;
  const envFile = "/tmp/pi vault env 'quoted.sh";
  const result = await bash.prepareVaultBashCommand("printf '%s' \"$VAULT_api_key\"", {
    keyForVar: (varName) => varName === "VAULT_api_key" ? { scope: "global", key: "api-key" } : undefined,
    releaseKey: async ({ scope, key }) => ({ ...release, scope, key }),
    writeEnvFile: (vars) => { capturedVars = vars; return envFile; },
  });
  if (result.kind !== "prepared") throw new Error(`expected prepared, got ${result.kind}`);
  if (!capturedVars || capturedVars.length !== 1) throw new Error("expected one injected env var");
  if (capturedVars[0].varName !== "VAULT_api_key") throw new Error(`bad varName: ${capturedVars[0].varName}`);
  if (capturedVars[0].value !== release.value) throw new Error("env writer did not receive plaintext value");
  if (result.command.includes(release.value)) throw new Error("rewritten command leaks plaintext");
  if (!result.command.includes(bash.shellSingleQuote(envFile))) throw new Error(`env file path not shell-quoted: ${result.command}`);
  if (!result.command.includes("trap 'rm -f")) throw new Error("missing cleanup trap");
  if (result.record.grantKey !== "global:api-key") throw new Error(`bad grantKey: ${result.record.grantKey}`);
});

await check("writeVaultEnvFile creates env file with shell-escaped value", () => {
  const stateDir = fs.mkdtempSync(path.join(tmpDir, "state-"));
  const file = bash.writeVaultEnvFile(stateDir, [{ varName: "VAULT_quote", value: "a'b" }]);
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o600) throw new Error(`expected 0600, got ${mode.toString(8)}`);
  const body = fs.readFileSync(file, "utf8");
  if (!body.includes("export VAULT_quote='a'\\''b'")) throw new Error(`unexpected env file body: ${body}`);
});

await check("classifyWindowsVaultBashProfile accepts non-Windows platforms", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "linux", shellPath: "" });
  if (!profile.ok || profile.kind !== "non-windows") throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile accepts Git Bash paths", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "C:\\Program Files\\Git\\bin\\bash.exe", env: {} });
  if (!profile.ok || profile.kind !== "git-bash") throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile accepts MSYS2 profiles", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "C:\\msys64\\usr\\bin\\bash.exe", env: { MSYSTEM: "MINGW64" } });
  if (!profile.ok || profile.kind !== "msys2") throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile accepts MSYS2 path without parent env", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "C:\\msys64\\usr\\bin\\bash.exe", env: {} });
  if (!profile.ok || profile.kind !== "msys2") throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile blocks WSL bash", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "C:\\Windows\\System32\\bash.exe", env: {} });
  if (profile.ok || profile.kind !== "wsl" || !profile.reason.includes("WSL")) throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile blocks Cygwin bash", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "C:\\cygwin64\\bin\\bash.exe", env: {} });
  if (profile.ok || profile.kind !== "cygwin" || !profile.reason.includes("Cygwin")) throw new Error(JSON.stringify(profile));
});

await check("classifyWindowsVaultBashProfile blocks unknown Windows bash", () => {
  const profile = bash.classifyWindowsVaultBashProfile({ platform: "win32", shellPath: "", env: {} });
  if (profile.ok || profile.kind !== "unknown" || !profile.reason.includes("Git Bash/MSYS2")) throw new Error(JSON.stringify(profile));
});

// ── boot-aware scope routing ────────────────────────────────────
//
// We touch fake `.md.age` files in a tmp abrain home to exercise the disk-lookup
// half of buildBootVaultBashDeps. releaseKey isn't invoked from these resolver
// assertions because we call keyForVar directly.
const abrainHome = fs.mkdtempSync(path.join(tmpDir, "abrain-"));
function touchVault(abrainHome, scope, key) {
  const dir = scope === "global"
    ? path.join(abrainHome, "vault")
    : path.join(abrainHome, "projects", scope.project, "vault");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.md.age`), "dummy ciphertext\n", { mode: 0o600 });
}

touchVault(abrainHome, "global", "shared-token");
touchVault(abrainHome, "global", "github-token");
touchVault(abrainHome, { project: "pi-astack" }, "shared-token");
touchVault(abrainHome, { project: "pi-astack" }, "prod-db-password");

const projectDeps = bash.buildBootVaultBashDeps({ abrainHome, stateDir: path.join(tmpDir, "state-proj"), activeProjectId: "pi-astack" });
const unboundDeps = bash.buildBootVaultBashDeps({ abrainHome, stateDir: path.join(tmpDir, "state-unbound"), activeProjectId: null });

await check("$VAULT_<key>: prefers active project when both layers have the key", () => {
  const match = projectDeps.keyForVar("VAULT_shared_token", "VAULT_");
  if (!match || match.scope.project !== "pi-astack" || match.key !== "shared-token") throw new Error(JSON.stringify(match));
});

await check("$VAULT_<key>: falls back to global when active project is missing it", () => {
  const match = projectDeps.keyForVar("VAULT_github_token", "VAULT_");
  if (!match || match.scope !== "global" || match.key !== "github-token") throw new Error(JSON.stringify(match));
});

await check("$GVAULT_<key>: only consults global even if active project has the key", () => {
  const match = projectDeps.keyForVar("GVAULT_prod_db_password", "GVAULT_");
  if (match) throw new Error(`GVAULT must not see project keys: ${JSON.stringify(match)}`);
  const sharedAsGlobal = projectDeps.keyForVar("GVAULT_shared_token", "GVAULT_");
  if (!sharedAsGlobal || sharedAsGlobal.scope !== "global") throw new Error(JSON.stringify(sharedAsGlobal));
});

await check("$PVAULT_<key>: only consults active project, never global", () => {
  const match = projectDeps.keyForVar("PVAULT_prod_db_password", "PVAULT_");
  if (!match || match.scope.project !== "pi-astack") throw new Error(JSON.stringify(match));
  const onlyGlobal = projectDeps.keyForVar("PVAULT_github_token", "PVAULT_");
  if (onlyGlobal) throw new Error(`PVAULT must not fall back to global: ${JSON.stringify(onlyGlobal)}`);
});

await check("$PVAULT_<key>: yields pvaultBlockReason when no project is bound", () => {
  const match = unboundDeps.keyForVar("PVAULT_anything", "PVAULT_");
  if (match) throw new Error(`expected no match, got ${JSON.stringify(match)}`);
  if (!unboundDeps.pvaultBlockReason) throw new Error("pvaultBlockReason should be set when no project");
});

await check("$VAULT_<key>: with no active project, queries global only", () => {
  const match = unboundDeps.keyForVar("VAULT_github_token", "VAULT_");
  if (!match || match.scope !== "global") throw new Error(JSON.stringify(match));
});

await check("prepareBootVaultBashCommand wires $PVAULT_* block reason end-to-end", async () => {
  const result = await bash.prepareBootVaultBashCommand("echo $PVAULT_db", {
    abrainHome,
    stateDir: path.join(tmpDir, "state-block"),
    activeProjectId: null,
    shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    env: {},
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("active project")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("prepareBootVaultBashCommand blocks unsupported Windows shells before injection", async () => {
  const result = await bash.prepareBootVaultBashCommand("echo $VAULT_github_token", {
    abrainHome,
    stateDir: path.join(tmpDir, "state-shell-block"),
    activeProjectId: null,
    shellPath: "C:\\Windows\\System32\\bash.exe",
    platform: "win32",
    env: {},
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("WSL")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("withheldVaultBashContent mentions key but not plaintext", () => {
  const content = bash.withheldVaultBashContent({ releases: [release] });
  const text = content[0].text;
  if (!text.includes("global:api-key")) throw new Error(`missing key label: ${text}`);
  if (text.includes(release.value)) throw new Error("withheld content leaked plaintext");
});

await check("redactVaultBashContent replaces literal secret with placeholder", () => {
  const content = bash.redactVaultBashContent([{ type: "text", text: `before ${release.value} after` }], [release]);
  const text = content[0].text;
  if (text.includes(release.value)) throw new Error(`redaction missed plaintext: ${text}`);
  if (!text.includes(release.placeholder)) throw new Error(`missing placeholder: ${text}`);
});

await check("authorization choice order is deny-first for bash output", () => {
  if (bash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0] !== "No") throw new Error(`first choice is ${bash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0]}`);
});

// ── ADR 0022 housekeeping batch A subgroup 1 post-audit (2026-05-19) ──
//
// OPUS-4-7 + DEEPSEEK-V4-pro xhigh consensus P0 caught a regression in
// the original batch A subgroup 1 ship: `authorizeVaultBashOutput`
// returns { decision, ui_path } now, but the tool_result handler
// initially still wrote `if (decision !== "release")` against the
// wrapper object — always true, every bash output silently withheld.
//
// We have no stage-index smoke yet (planned in Batch A subgroup 2:
// `smoke:abrain-vault-grant-isolation`). In the meantime grep-anchors
// in extensions/abrain/index.ts lock the post-fix contract so a future
// edit that reverts the wire-up fails this smoke deterministically.
//
// Negative-test verified manually: editing `outcome.decision` back to
// `decision` (the bug) or removing `outcome.ui_path` from either audit
// call makes the matching anchor fail.
await check("post-audit P0 fix anchors: tool_result handler wires outcome.decision + outcome.ui_path", () => {
  const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions", "abrain", "index.ts"), "utf8");
  const anchors = [
    // (a) The fix renamed the local to `outcome` AND destructured
    //     `.decision` for the comparison. Both must appear together.
    "const outcome = await authorizeVaultBashOutput(",
    'if (outcome.decision !== "release") {',
    // (b) Both audit calls MUST pass outcome.ui_path — this is the
    //     payoff of batch A (g) on the bash_output lane. Without
    //     these, `ui_path` is missing from every bash_output audit row
    //     and (g) is only half-shipped (vault_release lane only).
    'auditBashOutput("bash_output_withhold", record, outcome.ui_path)',
    'auditBashOutput("bash_output_release", record, outcome.ui_path)',
    // (c) The buggy pre-fix patterns MUST NOT reappear. We grep them
    //     out to catch a regression that re-introduces the object-vs-string
    //     comparison.
  ];
  for (const needle of anchors) {
    if (!indexSrc.includes(needle)) {
      throw new Error(
        `regression: post-audit P0-fix anchor missing from index.ts:\n  needle: ${JSON.stringify(needle)}\n  ` +
          "This anchor locks the fix from 2026-05-19 OPUS+DEEPSEEK xhigh review. " +
          "If the wire-up between authorizeVaultBashOutput's outcome and the audit " +
          "call was intentionally restructured, update both the code and the anchor list.",
      );
    }
  }
  // Negative anchors: the pre-fix buggy patterns MUST be gone.
  //
  // NOTE: we do NOT grep the bare `auditBashOutput(..., record);` /
  // `auditBashOutput(..., record);` 2-arg calls in isolation, because
  // ONE legitimate 2-arg call survives in the outer-envelope catch
  // block: when the outer try around authorizeVaultBashOutput throws,
  // we genuinely don't know which UI path would have been taken, so
  // we deliberately omit ui_path (the absence itself is the
  // diagnostic signal). OPUS-4-7 P1-5 (2026-05-19) verified this
  // omission is intentional. Anchor on the unambiguous bug signature
  // instead: `if (decision !== "release")` is ONLY emitted by the
  // pre-fix object-vs-string compare.
  const buggy = [
    'if (decision !== "release")',
  ];
  for (const needle of buggy) {
    if (indexSrc.includes(needle)) {
      throw new Error(
        `regression: pre-fix buggy pattern reappeared in index.ts:\n  needle: ${JSON.stringify(needle)}\n  ` +
          "This is the exact pattern the 2026-05-19 post-audit P0 fix removed. " +
          "It compared the BashOutputAuthOutcome wrapper object against the literal " +
          'string "release", which is always true — silently withholding every vault ' +
          "bash output. Restore the outcome.decision destructure.",
      );
    }
  }
});

await check("Windows vault bash path is owned by pi-astack settings, not pi core shellPath", () => {
  const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions", "abrain", "index.ts"), "utf8");
  const anchors = [
    'const PI_STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");',
    'const DEFAULT_WINDOWS_VAULT_BASH_PATH = "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe";',
    "const configured = abrain.windowsVaultBashPath;",
  ];
  for (const needle of anchors) {
    if (!indexSrc.includes(needle)) {
      throw new Error(
        `regression: pi-astack-owned Windows vault bash setting anchor missing:\n  needle: ${JSON.stringify(needle)}`,
      );
    }
  }
  const forbidden = ["SettingsManager", "getShellConfig", "getShellPath"];
  for (const needle of forbidden) {
    if (indexSrc.includes(needle)) {
      throw new Error(
        `regression: abrain index.ts reads pi core shellPath again:\n  needle: ${JSON.stringify(needle)}`,
      );
    }
  }
});

// ADR 0022 batch C (2026-05-19): grep anchor for non-configurable
// globalThis hook (`__abrainPromptUserGetPending`). This is the
// defense-in-depth follow-up to OPUS P1-3 round 2: published as a
// plain assignment, the INV-K compaction-defer hook could be
// silently rebound to `() => 0` by a misbehaving extension or LLM
// eval path, disabling defer and letting compaction tear down
// active prompt_user dialogs. Anchor the defineProperty +
// configurable:false form so a future edit that reverts to plain
// assignment fails this smoke.
//
// Negative-test verified manually: replacing `Object.defineProperty`
// with the prior `(globalThis as ...).X = fn` form makes this fail.
await check("batch C: __abrainPromptUserGetPending is installed non-configurable", () => {
  const indexSrc = fs.readFileSync(path.join(repoRoot, "extensions", "abrain", "index.ts"), "utf8");
  const anchors = [
    'Object.defineProperty(globalThis, "__abrainPromptUserGetPending"',
    "configurable: false",
    "writable: false",
  ];
  for (const needle of anchors) {
    if (!indexSrc.includes(needle)) {
      throw new Error(
        `regression: batch C non-configurable hook anchor missing:\n  needle: ${JSON.stringify(needle)}\n  ` +
          "ADR 0022 batch C made __abrainPromptUserGetPending non-configurable so a " +
          "misbehaving extension cannot silently rebind it to '() => 0' and disable " +
          "INV-K compaction defer. If you intentionally reverted, update this anchor.",
      );
    }
  }
  // Negative anchor: the prior plain-assignment form must NOT reappear
  // at the activate() publish site. We anchor on the EXACT prior
  // assignment line, not the type cast or the helper itself.
  if (indexSrc.includes(".__abrainPromptUserGetPending =\n      ()")) {
    throw new Error(
      "regression: plain-assignment publish of __abrainPromptUserGetPending reappeared. " +
        "Batch C 2026-05-19 replaced this with Object.defineProperty + configurable:false.",
    );
  }
});

// ADR 0022 batch C post-audit (2026-05-19, 3-way OPUS+GPT+DEEPSEEK
// unanimous P1): pin assertion count to match the discipline already
// applied in smoke-abrain-vault-grant-isolation. A future edit that
// silently drops a check(...) block now fails this smoke with
// 'assertion count drift' rather than passing with reduced coverage.
const EXPECTED_ASSERTIONS = 29;
if (total !== EXPECTED_ASSERTIONS) {
  failures.push({
    name: "assertion count drift",
    err: new Error(
      `expected ${EXPECTED_ASSERTIONS} assertions, ran ${total}. ` +
        "If you intentionally added/removed a check(...), bump EXPECTED_ASSERTIONS.",
    ),
  });
}

console.log("");
if (failures.length === 0) {
  console.log(`all ok — vault-backed bash helper holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
