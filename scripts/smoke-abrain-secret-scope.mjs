#!/usr/bin/env node
/**
 * Smoke test: ADR 0014 P1 step 2 — /secret default scope is the boot-time
 * active project. Pure flag-parsing + scope-resolution coverage; the live
 * write/list/forget paths are still covered by smoke-abrain-vault-writer.
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
const pendingChecks = [];
let total = 0;
function check(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pendingChecks.push(Promise.resolve(result).then(
        () => console.log(`  ok    ${name}`),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err.message}`);
        },
      ));
      return;
    }
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-secret-scope-"));
const sharedTarget = path.join(tmpDir, "_shared");
fs.mkdirSync(sharedTarget, { recursive: true });
fs.writeFileSync(path.join(sharedTarget, "runtime.cjs"), transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")));
fs.copyFileSync(path.join(sharedTarget, "runtime.cjs"), path.join(sharedTarget, "runtime.js"));
// PR-1 (2026-06-10): git-sync.ts / index.ts now import two more _shared
// modules. Bridge them INSIDE tmpDir (self-sufficient — do not lean on
// <os-tmp>/_shared residue from other smokes): causal-anchor as a stub
// (anchor enrichment not under test), git-singleflight as the REAL module
// (lock routing is part of /abrain bind's commit path now).
fs.writeFileSync(path.join(sharedTarget, "causal-anchor.cjs"), `module.exports = { getCurrentAnchor: () => undefined, spreadAnchor: () => ({}) };\n`);
fs.writeFileSync(path.join(sharedTarget, "pi-internals.cjs"), `module.exports = { isSubAgentSession: () => false };\n`);
fs.writeFileSync(path.join(sharedTarget, "llm-audit.cjs"), `module.exports = { auditStreamSimple: async () => ({ stopReason: "error", content: [] }) };\n`);
fs.writeFileSync(path.join(sharedTarget, "git-singleflight.cjs"), transpile(path.join(repoRoot, "extensions/_shared/git-singleflight.ts")));
fs.writeFileSync(path.join(sharedTarget, "canonical-mutation-barrier.cjs"), "exports.withCanonicalMutationBarrier = async (_repo, operation) => operation(); exports.withoutCanonicalMutationBarrierContext = (operation) => operation();\n");
fs.writeFileSync(path.join(sharedTarget, "durable-write.cjs"), "exports.durableAtomicWriteFile = async () => {}; exports.durableAtomicCreateFile = async () => 'created';\n");
fs.writeFileSync(path.join(sharedTarget, "device-join-coordinator.cjs"), "exports.recoverDeviceJoinJournal = async () => {}; exports.prepareDeviceJoinForSync = async () => ({}); exports.publishPreparedDeviceJoinForSync = async () => ({ status: 'ok' });\n");
fs.writeFileSync(path.join(sharedTarget, "canonical-git-runtime.cjs"), `
exports.canonicalGitRuntimeEnabled = () => false;
exports.createProducedArtifactReceipt = async () => ({});
exports.getCanonicalGitRuntime = async () => ({ awaitStartup: async () => ({ startup: 'ready' }), requestDrain: async () => ({ status: 'empty' }) });
exports.getCanonicalStartupPromise = async () => ({ startup: 'ready' });
exports.peekCanonicalRuntimeDiagnostics = () => ({ status: 'none' });
exports.reportCanonicalStartupConsumer = () => {};
exports.scheduleCanonicalStartupConsumer = async () => {};
exports.setCanonicalStartupReporter = () => {};
`);
fs.writeFileSync(path.join(tmpDir, "bind-intent.cjs"), `
exports.applyAllPendingAbrainBindIntents = async () => ({ applied: 0, pending: 0, failed: 0, details: [] });
exports.applyLocalMapOnlyBind = async () => ({ localPathAdded: false, localMapPath: '/tmp/local-map.json' });
exports.intentFromPlan = (plan) => ({ itemId: '0'.repeat(64), ...plan });
exports.planAbrainBind = async () => ({ needsTrackedAbrainWrite: false, localMapOnly: true, projectId: 'x', projectRoot: '/x', manifestPath: '/x/.abrain-project.json', registryPath: '/a/_project.json', abrainGitignorePath: '/a/.gitignore', manifestCreated: false, registryCreated: false, abrainGitignoreUpdated: false });
exports.writeAbrainBindIntent = async () => ({ status: 'created', itemId: '0'.repeat(64), filePath: '/tmp/intent.json' });
`);
fs.writeFileSync(path.join(tmpDir, "reconcile-gate.cjs"), transpile(path.join(repoRoot, "extensions/abrain/reconcile-gate.ts")));
fs.copyFileSync(path.join(tmpDir, "reconcile-gate.cjs"), path.join(tmpDir, "reconcile-gate.js"));

// ADR 0022 P1: "redact" added — git-sync.ts re-exports redactCredentials
// from ./redact. The for-loop already writes both .cjs and .js aliases,
// so adding the name suffices.
// ADR 0022 P3b: "vault-authorize" added — abrain/index.ts imports it for
// PromptDialog overlay path on vault release / bash output authorization.
for (const file of ["vault-writer", "vault-reader", "vault-bash", "keychain", "bootstrap", "backend-detect", "i18n", "brain-layout", "git-sync", "redact", "vault-authorize"]) {
  // P1-2 audit fix 2026-05-16 round 4: brain-layout.ts now imports
  // `../_shared/runtime` for computeAbrainStateGitignoreNext. Rewrite
  // the relative require to point at the shared helper we already wrote
  // to <tmpDir>/_shared/runtime.cjs above. Other files happen not to
  // import _shared today, but applying the rewrite uniformly is harmless
  // (no-op when the pattern isn't present) and future-proofs new shared
  // imports.
  const compiled = transpile(path.join(repoRoot, "extensions/abrain", `${file}.ts`))
    .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")')
    .replace(/require\("\.\.\/_shared\/causal-anchor"\)/g, 'require("./_shared/causal-anchor.cjs")')
    .replace(/require\("\.\.\/_shared\/llm-audit"\)/g, 'require("./_shared/llm-audit.cjs")')
    .replace(/require\("\.\.\/_shared\/git-singleflight"\)/g, 'require("./_shared/git-singleflight.cjs")')
    .replace(/require\("\.\.\/_shared\/device-join-coordinator"\)/g, 'require("./_shared/device-join-coordinator.cjs")')
    .replace(/require\("\.\.\/_shared\/canonical-git-runtime"\)/g, 'require("./_shared/canonical-git-runtime.cjs")')
    .replace(/require\("\.\.\/_shared\/durable-write"\)/g, 'require("./_shared/durable-write.cjs")');
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), compiled);
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}
fs.writeFileSync(path.join(tmpDir, "rule-injector.js"), "module.exports = function activateRuleInjectorForSmoke() {};\n");

let indexSrc = fs.readFileSync(path.join(repoRoot, "extensions/abrain/index.ts"), "utf8");
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
  .replace(/require\("\.\/rule-injector"\)/g, 'require("./rule-injector.js")')
  .replace(/require\("\.\/bind-intent"\)/g, 'require("./bind-intent.cjs")')
  .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")')
  .replace(/require\("\.\.\/_shared\/causal-anchor"\)/g, 'require("./_shared/causal-anchor.cjs")')
  .replace(/require\("\.\.\/_shared\/git-singleflight"\)/g, 'require("./_shared/git-singleflight.cjs")')
  .replace(/require\("\.\.\/_shared\/canonical-mutation-barrier"\)/g, 'require("./_shared/canonical-mutation-barrier.cjs")')
  .replace(/require\("\.\.\/_shared\/canonical-git-runtime"\)/g, 'require("./_shared/canonical-git-runtime.cjs")')
  .replace(/require\("\.\.\/_shared\/durable-write"\)/g, 'require("./_shared/durable-write.cjs")')
  .replace(/require\("\.\.\/_shared\/pi-internals"\)/g, 'require("./_shared/pi-internals.cjs")');
fs.writeFileSync(path.join(tmpDir, "index.cjs"), indexCjs);

const indexModule = require(path.join(tmpDir, "index.cjs"));

console.log("abrain — /secret scope parsing");

check("parseSecretScopeFlags: default scope when no flags", () => {
  const r = indexModule.parseSecretScopeFlags(["token=abc"]);
  if (r.scope !== "default") throw new Error(`scope=${JSON.stringify(r.scope)}`);
  if (r.positional.join(",") !== "token=abc") throw new Error(`positional=${r.positional}`);
  if (r.errors.length) throw new Error(`unexpected errors: ${r.errors}`);
});

check("parseSecretScopeFlags: --global wins as global scope", () => {
  const r = indexModule.parseSecretScopeFlags(["--global", "token=abc"]);
  if (r.scope !== "global") throw new Error(`scope=${JSON.stringify(r.scope)}`);
});

check("parseSecretScopeFlags: --project=<id> yields project scope", () => {
  const r = indexModule.parseSecretScopeFlags(["--project=pi-astack", "token=abc"]);
  if (typeof r.scope !== "object" || r.scope.project !== "pi-astack") throw new Error(`scope=${JSON.stringify(r.scope)}`);
});

check("parseSecretScopeFlags: rejects invalid --project=<id>", () => {
  const r = indexModule.parseSecretScopeFlags(["--project=../escape", "token=abc"]);
  if (r.errors.length === 0) throw new Error("expected error");
});

check("parseSecretScopeFlags: --global + --project=<id> mutually exclusive", () => {
  const r = indexModule.parseSecretScopeFlags(["--global", "--project=alpha", "token=abc"]);
  if (!r.errors.some((e) => e.includes("mutually exclusive"))) throw new Error(`errors=${r.errors}`);
});

check("parseSecretScopeFlags: --all-projects flag captured", () => {
  const r = indexModule.parseSecretScopeFlags(["--all-projects"]);
  if (!r.allProjects) throw new Error("allProjects flag not set");
});

check("parseSecretScopeFlags: --all-projects + scope flag error", () => {
  const r = indexModule.parseSecretScopeFlags(["--all-projects", "--global"]);
  if (!r.errors.some((e) => e.includes("--all-projects"))) throw new Error(`errors=${r.errors}`);
});

check("parseSecretScopeFlags: unknown flag captured as error", () => {
  const r = indexModule.parseSecretScopeFlags(["--what"]);
  if (!r.errors.some((e) => e.includes("unknown flag"))) throw new Error(`errors=${r.errors}`);
});

check("resolveSecretScope: --global passes through", () => {
  const out = indexModule.resolveSecretScope("global", null);
  if (!out.ok || out.scope !== "global") throw new Error(JSON.stringify(out));
});

check("resolveSecretScope: --project=<id> cannot bypass missing active project", () => {
  const out = indexModule.resolveSecretScope({ project: "explicit" }, null);
  if (out.ok) throw new Error(`expected refusal, got ${JSON.stringify(out)}`);
  if (!out.reason.includes("missing .abrain-project.json")) throw new Error(`reason=${out.reason}`);
});

check("resolveSecretScope: default with no active project surfaces reason", () => {
  const out = indexModule.resolveSecretScope("default", null);
  if (out.ok) throw new Error("expected refusal");
  if (!out.reason.includes("missing .abrain-project.json")) throw new Error(`reason=${out.reason}`);
});

check("resolveSecretScope: default + path_unconfirmed reason carries actionable hint", () => {
  const stub = { activeProject: null, reason: "path_unconfirmed", cwd: "/x", projectRoot: "/x", projectId: "alpha" };
  const out = indexModule.resolveSecretScope("default", stub);
  if (out.ok) throw new Error("expected refusal");
  if (!out.reason.includes("not confirmed on this local path")) throw new Error(`reason=${out.reason}`);
});

check("resolveSecretScope: default + active project routes to that project", () => {
  const stub = { activeProject: { projectId: "alpha", matchedBy: "strict_local_map", cwd: "/x", lookupCwd: "/x", projectRoot: "/x", manifestPath: "/x/.abrain-project.json", registryPath: "/a/projects/alpha/_project.json", localMapPath: "/a/.state/projects/local-map.json", localPath: { path: "/x", first_seen: "t", last_seen: "t", confirmed_at: "t" }, manifest: { schema_version: 1, project_id: "alpha" }, registry: { schema_version: 1, project_id: "alpha", created_at: "t", updated_at: "t" } } };
  const out = indexModule.resolveSecretScope("default", stub);
  if (!out.ok) throw new Error("expected ok");
  if (out.scope.project !== "alpha") throw new Error(`scope=${JSON.stringify(out.scope)}`);
});

check("secretDefaultRejection covers strict binding failure paths", () => {
  const missing = indexModule.secretDefaultRejection("manifest_missing");
  if (!missing.includes("missing .abrain-project.json")) throw new Error(missing);
  const conflict = indexModule.secretDefaultRejection("path_conflict");
  if (!conflict.includes("already confirmed for another project")) throw new Error(conflict);
});

check("boot-time snapshot helpers expose getter+reset", () => {
  if (typeof indexModule.getBootActiveProject !== "function") throw new Error("getBootActiveProject missing");
  if (typeof indexModule.getBootActiveProjectSnapshotAt !== "function") throw new Error("snapshot timestamp missing");
  if (typeof indexModule.__resetBootActiveProjectForTests !== "function") throw new Error("reset helper missing");
});

check("autoCommitPaths commits only the requested binding artifacts", async () => {
  if (typeof indexModule.autoCommitPaths !== "function") throw new Error("autoCommitPaths missing");
  const repo = fs.mkdtempSync(path.join(tmpDir, "autocommit-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "smoke@pi-astack.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "pi-astack smoke"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# smoke\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

  fs.writeFileSync(path.join(repo, ".abrain-project.json"), JSON.stringify({ schema_version: 1, project_id: "smoke" }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "must stay uncommitted\n");
  execFileSync("git", ["-C", repo, "add", "unrelated.txt"]);
  const result = await indexModule.autoCommitPaths(repo, [".abrain-project.json"], "chore: bind abrain project smoke");
  if (result.status !== "committed") throw new Error(`expected committed, got ${JSON.stringify(result)}`);
  const committedFiles = execFileSync("git", ["-C", repo, "show", "--name-only", "--pretty=format:", "HEAD"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
  if (JSON.stringify(committedFiles) !== JSON.stringify([".abrain-project.json"])) throw new Error(`commit should include only binding artifact, got ${JSON.stringify(committedFiles)}`);
  const staged = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
  if (JSON.stringify(staged) !== JSON.stringify(["unrelated.txt"])) throw new Error(`unrelated staged changes should remain staged, got ${JSON.stringify(staged)}`);
  const clean = await indexModule.autoCommitPaths(repo, [".abrain-project.json"], "noop");
  if (clean.status !== "clean") throw new Error(`second autocommit should be clean, got ${JSON.stringify(clean)}`);
});

check("/abrain status is read-only and does not mutate boot active project", () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions/abrain/index.ts"), "utf-8");
  const statusBranch = src.match(/if \(sub === "status"\) \{[\s\S]*?\n  \}/)?.[0] || "";
  if (!statusBranch.includes("const current = snapshotBootActiveProject")) throw new Error(`status branch should compute a local snapshot: ${statusBranch}`);
  if (/bootActiveProject\s*=/.test(statusBranch)) throw new Error(`status branch must not assign bootActiveProject: ${statusBranch}`);
});

check("__resetBootActiveProjectForTests round-trips an active project value", () => {
  const stub = { activeProject: { projectId: "alpha", matchedBy: "strict_local_map", cwd: "/x", lookupCwd: "/x", projectRoot: "/x", manifestPath: "/x/.abrain-project.json", registryPath: "/a/projects/alpha/_project.json", localMapPath: "/a/.state/projects/local-map.json", localPath: { path: "/x", first_seen: "t", last_seen: "t", confirmed_at: "t" }, manifest: { schema_version: 1, project_id: "alpha" }, registry: { schema_version: 1, project_id: "alpha", created_at: "t", updated_at: "t" } } };
  indexModule.__resetBootActiveProjectForTests(stub);
  if (indexModule.getBootActiveProject() !== stub) throw new Error("snapshot not stored");
  if (typeof indexModule.getBootActiveProjectSnapshotAt() !== "number") throw new Error("snapshot timestamp missing");
  indexModule.__resetBootActiveProjectForTests(null);
  if (indexModule.getBootActiveProject() !== null) throw new Error("reset to null failed");
});

// Vault execution-domain AST: slash writes use local safety only, never Path A
// canonical startup barriers (awaitAbrainCanonicalWriteBarrier etc.).
check("vault slash execution domain uses local safety only (AST)", () => {
  const srcPath = path.join(repoRoot, "extensions/abrain/index.ts");
  const src = fs.readFileSync(srcPath, "utf-8");
  const sf = ts.createSourceFile(srcPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  function textOf(node) {
    return src.slice(node.getStart(sf), node.getEnd());
  }

  function findFunction(name) {
    let found = null;
    function visit(node) {
      if (found) return;
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === name
      ) {
        found = node;
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) && decl.name.text === name
            && decl.initializer
            && (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer))
          ) {
            found = decl.initializer;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
  }

  function findRegisterCommandHandler(commandName) {
    let found = null;
    function visit(node) {
      if (found) return;
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "registerCommand"
        && node.arguments.length >= 2
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === commandName
        && ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        for (const prop of node.arguments[1].properties) {
          if (
            ts.isPropertyAssignment(prop)
            && ts.isIdentifier(prop.name)
            && prop.name.text === "handler"
          ) {
            found = prop.initializer;
            return;
          }
          if (
            ts.isMethodDeclaration(prop)
            && prop.name && ts.isIdentifier(prop.name)
            && prop.name.text === "handler"
          ) {
            found = prop;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
  }

  const forbidden = [
    "awaitAbrainCanonicalWriteBarrier",
    "getCanonicalStartupPromise",
    "withCanonicalMutationBarrier",
  ];

  function assertNoCanonical(label, node) {
    if (!node) throw new Error(`${label}: not found`);
    const body = textOf(node);
    for (const name of forbidden) {
      if (body.includes(name)) throw new Error(`${label}: must not reference ${name}`);
    }
  }

  const localGuard = findFunction("assertVaultLocalSafety");
  if (!localGuard) throw new Error("assertVaultLocalSafety not found");
  const guardText = textOf(localGuard);
  if (!guardText.includes("assertAbrainLocalWriteSafety")) {
    throw new Error("assertVaultLocalSafety must call assertAbrainLocalWriteSafety");
  }
  assertNoCanonical("assertVaultLocalSafety", localGuard);

  const handleSecret = findFunction("handleSecret");
  if (!handleSecret) throw new Error("handleSecret not found");
  const secretText = textOf(handleSecret);
  if (!secretText.includes("assertVaultLocalSafety")) {
    throw new Error("handleSecret must call assertVaultLocalSafety");
  }
  assertNoCanonical("handleSecret", handleSecret);

  const vaultHandler = findRegisterCommandHandler("vault");
  if (!vaultHandler) throw new Error('registerCommand("vault") handler not found');
  const vaultText = textOf(vaultHandler);
  if (!vaultText.includes("assertVaultLocalSafety")) {
    throw new Error("vault handler must call assertVaultLocalSafety");
  }
  assertNoCanonical('registerCommand("vault") handler', vaultHandler);
});

await Promise.all(pendingChecks);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`all ok — /secret scope parsing holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
