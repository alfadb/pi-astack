#!/usr/bin/env node
/** Offline R4.2 protocol smoke plus real-production read-only preview evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  DYNAMIC_SENTINEL,
  MAX_OBJECT_BYTES,
  REVISION,
  SCHEMAS,
  STATIC_SENTINEL,
  addSelfHash,
  adoptionPhrase,
  buildActivation,
  buildRuntimeAuditObject,
  canonicalObjectBytes,
  canonicalizeJcs,
  computeCommitToken,
  continuePhrase,
  fullIdentityFromBigintStat,
  initialPhrase,
  jcsSha256,
  openRetainedTranscript,
  parseStrictJson,
  recoveryPhrase,
  renderDesiredSubtree,
  runtimeAuditIdempotencyKey,
  sha256,
  validateActivationAgainstIntent,
  validateFullIdentity,
  validateOperationTupleAgainstStatic,
  validateReceiptAgainstClosure,
  validateRuntimeAuditObject,
} from "../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs";
import {
  bootstrapControl,
  convergePendingToFinal,
  linkFinalIdempotent,
  openAnchoredDirectory,
  pendingBasename,
  stagedPublish,
  stagedTempBasename,
  unlinkPendingIdempotent,
} from "../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-staged-publication.mjs";
import {
  ARTIFACT_PATHS,
  GENERATOR_PATH,
  PRODUCTION,
  adoptAmbientStateFixture,
  buildAdoptionPreviewFixture,
  buildDynamicReadOnlyReport,
  buildFixtureContract,
  buildFixtureCoordinate,
  buildPostDossierFixture,
  buildRuntimeEnablePreviewFixture,
  cleanupReceiptFinalPendingFixture,
  continueFixture,
  createInvocationMutationTracker,
  disposeRuntimeAuditTempFixture,
  disposeStagedTempFixture,
  evaluateRollbackGate,
  executeFixture,
  loadAndValidateStaticBundle,
  materializeRollbackFixture,
  materializeRuntimeAuditFixture,
  previewRuntimeAuditTempDispositionFixture,
  previewStagedTempDispositionFixture,
  progressRequiredAfter,
  recoverReceiptPendingFixture,
  runtimeEnableFixture,
  scanControlInventory,
  sourceGuard,
  validateStandaloneManifest,
  validateStaticContract,
  verifyTerminalFixture,
} from "../extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-r4.2-smoke-"));
let passed = 0;
const failures = [];
function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function loadTypescriptModule(relativePath) {
  const jitiPath = path.join(os.homedir(), ".volta", "tools", "image", "packages", "@earendil-works", "pi-coding-agent", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.mjs");
  assert(fs.existsSync(jitiPath), "pi-bundled jiti is required for the real resolver smoke");
  const { createJiti } = await import(pathToFileURL(jitiPath).href);
  const jiti = createJiti(import.meta.url);
  return jiti.import(path.join(repoRoot, relativePath));
}
async function check(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); }
}
function expectFailure(fn, fragments = []) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `expected failure containing ${fragments.join("|")}`);
  if (fragments.length) assert(fragments.some((fragment) => String(caught).includes(fragment)), `unexpected failure: ${caught}`);
  return caught;
}
function h(label) { return sha256(`r42-smoke:${label}`); }
function sessionFile(root, id, label) {
  const sessionsRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const file = path.join(sessionsRoot, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
  const rootRow = { type: "model_change", id: h(`${label}:root`).slice(0, 16), parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "fixture", modelId: "fixture" };
  const raw = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(rootRow)}\n`);
  fs.writeFileSync(file, raw, { mode: 0o600 });
  const stat = fs.lstatSync(file);
  return {
    session_id: id,
    sessions_root: sessionsRoot,
    session_file: { path: file, dev: stat.dev, ino: stat.ino, prefix_bytes: raw.length, prefix_sha256: sha256(raw), header_sha256: sha256(Buffer.from(JSON.stringify(header))) },
  };
}
function makeAuthorization(binding) {
  let text = "";
  let line = 10;
  let timestampMs = Date.now() - 1_000;
  const authorization = {
    previewBoundaryHash: h("fixture-preview-boundary"),
    previewBoundary: { line: 2, timestamp: new Date(timestampMs - 10_000).toISOString(), prefix_bytes: 200 },
    previewTimestamp: new Date(timestampMs - 10_000).toISOString(),
    grant(next) { text = next; line += 1; timestampMs += 1_000; },
    boundary() { return { prefix_bytes: line * 100, prefix_sha256: h(`boundary:${line}`), latest_line: line }; },
    verify({ expectedText, requiredAfter }) {
      if (text !== expectedText) throw new Error(`fixture exact authorization mismatch expected=${sha256(expectedText)} actual=${sha256(text)}`);
      if (requiredAfter?.line && line <= requiredAfter.line) throw new Error("fixture coordinate is not later");
      return buildFixtureCoordinate({ binding, text, line, timestamp: new Date(timestampMs).toISOString(), prefixBytes: line * 100 });
    },
    auto() {
      return {
        ...authorization,
        verify({ expectedText }) {
          authorization.grant(expectedText);
          return buildFixtureCoordinate({ binding, text: expectedText, line, timestamp: new Date(timestampMs).toISOString(), prefixBytes: line * 100 });
        },
      };
    },
  };
  return authorization;
}
function makeFixture(label, baseContract) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = sessionFile(root, `target-${label}`, `${label}:target`);
  const authBinding = sessionFile(root, `auth-${label}`, `${label}:auth`);
  const settingsPath = path.join(root, "settings.json");
  const settings = { unrelated: { keep: true, label }, ruleInjector: { propositionPolicyStableViewInjection: { enabled: true, selector: { session_ids: ["another-session"] } } } };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  const runtimeAuditBase = path.join(root, "runtime-base");
  fs.mkdirSync(runtimeAuditBase, { mode: 0o700 });
  const fixture = {
    root,
    settingsPath,
    controlRoot: path.join(root, "control"),
    rollbackRoot: path.join(root, "rollback"),
    runtimeAuditBase,
    runtimeAuditRoot: path.join(runtimeAuditBase, "adr0040-d3-v2-session-start-runtime-audit", "r4.2"),
    oldActivationRoot: path.join(root, "old-activations"),
    quarantineTarget: path.join(root, "quarantine", `${target.session_id}.jsonl`),
    targetSessionBinding: target,
    authorizationTranscriptBinding: authBinding,
  };
  const contract = buildFixtureContract(baseContract, fixture);
  const authorization = makeAuthorization(authBinding);
  const sourceCommit = "0".repeat(40);
  const baseArgs = { environment: "fixture", testOnly: true, fixtureRoot: root, contract, authorization, sourceCommit, sourceGuard: () => true, targetGuard: () => true };
  return { ...fixture, contract, authorization, sourceCommit, baseArgs, initialSettings: fs.readFileSync(settingsPath) };
}
function grantInitial(f) {
  f.authorization.grant(initialPhrase({ static_contract_hash: f.contract.static_contract_hash, source_commit: f.sourceCommit, target_session_id: f.contract.target_session_binding.session_id, preview_transcript_prefix_sha256: f.authorization.previewBoundaryHash }));
}
function operationIdFromControl(f) { return scanControlInventory(f.contract).operation_id; }
function authorityRow(f, kind, role = "final") {
  const row = scanControlInventory(f.contract).rows.find((item) => item.kind === kind && item.role === role);
  assert(row?.parsed, `missing ${kind}/${role} authority row`);
  return row;
}
function reselfHash(value, hashField) {
  const next = structuredClone(value);
  delete next[hashField];
  return addSelfHash(next, hashField);
}
function writeCanonicalAuthority(file, value, hashField) {
  const closed = reselfHash(value, hashField);
  fs.writeFileSync(file, canonicalObjectBytes(closed, hashField), { mode: 0o600 });
  return closed;
}
function crashOnAuthorityState(f, kind, role) {
  return ({ syscall }) => {
    const expectedSyscall = role === "pending" ? "fsync_parent_after_temp_unlink" : "fsync_parent_after_final_link";
    if (syscall !== expectedSyscall) return;
    const rows = scanControlInventory(f.contract).rows;
    const hasExpected = rows.some((row) => row.kind === kind && row.role === role);
    const hasPending = rows.some((row) => row.kind === kind && row.role === "pending");
    if (hasExpected && hasPending) throw new Error(`crash-${kind}-${role}`);
  };
}
function grantContinue(f) {
  const id = operationIdFromControl(f);
  f.authorization.grant(continuePhrase({ operation_id: id, static_contract_hash: f.contract.static_contract_hash, source_commit: f.sourceCommit }));
}
function protectedSnapshot(paths) {
  return paths.map((file) => {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile()) return { path: file, type: "file", dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, size: stat.size, raw_sha256: sha256(fs.readFileSync(file)) };
      if (stat.isDirectory()) return { path: file, type: "directory", dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, entries: fs.readdirSync(file).sort() };
      return { path: file, type: "other", dev: stat.dev, ino: stat.ino };
    } catch (error) { if (error.code === "ENOENT") return { path: file, type: "absent" }; throw error; }
  });
}
function requireGit(cwd, args, label) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  assert(!result.error && result.status === 0, `${label}: ${result.error?.message ?? result.stderr.toString("utf8")}`);
  return result.stdout;
}
function inspectActualHeadClosure(bundle) {
  const head = requireGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "cannot resolve actual closure HEAD").toString("utf8").trim();
  const artifactPaths = Object.values(ARTIFACT_PATHS).filter((relative) => relative !== ARTIFACT_PATHS.post_dossier);
  const paths = [...new Set([...artifactPaths, ...bundle.source.value.closure_rows.map((row) => row.relative_path)])].sort();
  const rows = paths.map((relative) => {
    const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relative], { encoding: "buffer" }).status === 0;
    const status = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", relative], { encoding: "buffer" });
    const headBlob = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `${head}:${relative}`], { encoding: "buffer" });
    let live;
    try { live = fs.readFileSync(path.join(repoRoot, ...relative.split("/"))); } catch {}
    return { relative_path: relative, tracked, clean: status.status === 0 && status.stdout.length === 0, live_equals_head: headBlob.status === 0 && Buffer.isBuffer(live) && live.equals(headBlob.stdout) };
  });
  return { head, paths: rows, ready: rows.every((row) => row.tracked && row.clean && row.live_equals_head) };
}
function createIndexSnapshotRepo(label) {
  const root = path.join(tmp, label);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  requireGit(repoRoot, ["checkout-index", "--all", "--force", `--prefix=${root}${path.sep}`], "cannot export smoke index snapshot");
  requireGit(root, ["init", "--quiet"], "cannot initialize smoke index repository");
  requireGit(root, ["config", "user.email", "r42-index-smoke@example.invalid"], "cannot configure smoke Git email");
  requireGit(root, ["config", "user.name", "R42 Index Smoke"], "cannot configure smoke Git name");
  requireGit(root, ["add", "-A"], "cannot stage smoke index repository");
  requireGit(root, ["commit", "--quiet", "-m", "index snapshot baseline"], "cannot commit smoke index repository");
  return root;
}
function worktreeRegistry(root) { return requireGit(root, ["worktree", "list", "--porcelain"], "cannot inspect smoke worktree registry"); }
function replaceExact(file, before, after) {
  const raw = fs.readFileSync(file, "utf8");
  assert(raw.includes(before) && raw.indexOf(before) === raw.lastIndexOf(before), `fixture replacement is not unique in ${file}`);
  fs.writeFileSync(file, raw.replace(before, after));
}

process.stdout.write("ADR0040 D3-v2 session_start R4.2 smoke\n");
let artifactBundle;
try {
  await check("content-only generator builds three standalone manifests and six-artifact hash DAG without source commit fixed point", async () => {
    const committed = loadAndValidateStaticBundle(repoRoot);
    artifactBundle = {
      source_snapshot: "index",
      values: {
        source_manifest: committed.source.value,
        adapter_manifest: committed.adapter.value,
        operator_manifest: committed.operator.value,
        static_contract: committed.contract.value,
        static_dossier: committed.dossier.value,
        static_preview_template: committed.preview.value,
      },
      raws: {
        source_manifest: committed.source.raw,
        adapter_manifest: committed.adapter.raw,
        operator_manifest: committed.operator.raw,
        static_contract: committed.contract.raw,
        static_dossier: committed.dossier.raw,
        static_preview_template: committed.preview.raw,
      },
    };
    for (const relative of ["extensions/_shared/canonical-git-runtime.ts", "extensions/_shared/runtime.ts", "extensions/sediment/writer.ts"]) {
      const indexed = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `:${relative}`], { encoding: "buffer" });
      assert(indexed.status === 0, `cannot read smoke index blob ${relative}`);
      const row = artifactBundle.values.source_manifest.closure_rows.find((item) => item.relative_path === relative);
      assert(row?.raw_sha256 === sha256(indexed.stdout), `index snapshot row used non-index bytes for ${relative}`);
      const liveHash = sha256(fs.readFileSync(path.join(repoRoot, relative)));
      if (liveHash !== row.raw_sha256) assert(row.raw_sha256 !== liveHash, `dirty live bytes leaked into index snapshot for ${relative}`);
    }
    const summary = spawnSync(process.execPath, [path.join(repoRoot, GENERATOR_PATH), "--summary", "--source-snapshot=index"], { cwd: repoRoot, encoding: "utf8", timeout: 600000 });
    assert(summary.status === 0 && parseStrictJson(summary.stdout).source_snapshot === "index", summary.stderr || "index snapshot CLI summary failed");
    const verify = spawnSync(process.execPath, [path.join(repoRoot, GENERATOR_PATH), "--verify", "--source-snapshot=index"], { cwd: repoRoot, encoding: "utf8", timeout: 600000 });
    assert(verify.status === 0 && parseStrictJson(verify.stdout).source_snapshot === "index", verify.stderr || "index snapshot CLI verify failed");
    for (const kind of ["source", "adapter", "operator"]) validateStandaloneManifest(artifactBundle.values[`${kind}_manifest`], kind);
    validateStaticContract(artifactBundle.values.static_contract, { source: artifactBundle.values.source_manifest, adapter: artifactBundle.values.adapter_manifest, operator: artifactBundle.values.operator_manifest });
    const text = Object.values(artifactBundle.raws).map((raw) => raw.toString("utf8")).join("\n");
    assert(!/"source_commit"\s*:/.test(text), "committed artifact contains source_commit field");
    assert(!/"[0-9a-f]{40}"/.test(text), "committed artifact contains exact 40hex value");
    for (const artifact of Object.values(ARTIFACT_PATHS)) {
      if (artifact === ARTIFACT_PATHS.post_dossier) continue;
      assert(!artifactBundle.values.source_manifest.closure_rows.some((row) => row.relative_path === artifact || row.dependencies.includes(artifact)), `artifact entered closure: ${artifact}`);
    }

    const { buildTypescriptStaticDependencyGraph } = await loadTypescriptModule("extensions/_shared/typescript-static-dependency-graph.ts");
    const graph = buildTypescriptStaticDependencyGraph({
      repoRoot,
      roots: ["extensions/abrain/rule-injector/index.ts"],
    });
    const compiledRoot = path.join(tmp, "commonjs-rule-injector");
    const requiredRuntimePaths = [
      "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-r42-runtime-control.ts",
      "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs",
      "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-staged-publication.mjs",
      "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs",
    ];
    const graphPaths = new Set(graph.files.map((row) => row.path));
    for (const relative of requiredRuntimePaths) assert(graphPaths.has(relative), `CommonJS graph omitted ${relative}`);
    for (const row of graph.files) {
      const source = path.join(repoRoot, row.path);
      const isTypescript = /\.(?:ts|mts|cts)$/.test(row.path);
      const targetRelative = isTypescript ? row.path.replace(/\.(?:ts|mts|cts)$/, ".js") : row.path;
      const target = path.join(compiledRoot, targetRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (isTypescript) {
        const output = ts.transpileModule(fs.readFileSync(source, "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            esModuleInterop: true,
            skipLibCheck: true,
          },
        }).outputText;
        fs.writeFileSync(target, output, "utf8");
      } else fs.copyFileSync(source, target);
    }
    // The extension host supplies pi internals through jiti; the CommonJS
    // fixture keeps the same explicit host boundary as the main injector smoke.
    fs.writeFileSync(path.join(compiledRoot, "extensions/_shared/pi-internals.js"), `module.exports = {
  markSessionAsSubAgent: () => {},
  isSubAgentSession: () => false,
};\n`, "utf8");
    const schemaTarget = path.join(compiledRoot, "schemas/l1-schema-role-registry.json");
    fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "schemas/l1-schema-role-registry.json"), schemaTarget);
    const compiledIndex = path.join(compiledRoot, "extensions/abrain/rule-injector/index.js");
    const compiledR42 = path.join(compiledRoot, "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-r42-runtime-control.js");
    const loaded = spawnSync(process.execPath, ["-e", `const main=require(${JSON.stringify(compiledIndex)});const r42=require(${JSON.stringify(compiledR42)});if(typeof main.default!=="function"||typeof main.scanRules!=="function"||typeof r42.decideD3V2R42RuntimeControl!=="function")process.exit(9);`], {
      cwd: compiledRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: [path.join(repoRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
      timeout: 120000,
    });
    assert(loaded.status === 0, `CommonJS main/R4.2 load failed: ${loaded.stderr || loaded.stdout}`);
  });

  await check("static manifest projections are six-field identities and R4.1 publication is absent from adapter dependencies", () => {
    const contract = artifactBundle.values.static_contract;
    for (const kind of ["source", "adapter", "operator"]) assert(JSON.stringify(Object.keys(contract[`${kind}_manifest`]).sort()) === JSON.stringify(["file_count", "graph_hash", "kind", "relative_path", "self_hash", "source_closure_hash"]), `${kind} projection keys differ`);
    const pins = JSON.stringify(artifactBundle.values.adapter_manifest.dependency_pins);
    assert(!pins.includes("retained-fd-create-only") && !pins.includes("session-start-r4.ts"), "R4.1 publication dependency pin leaked");
  });

  await check("forged legacy child env at the exact live root cannot bypass index parent isolation under unstaged semantic drift", () => {
    const root = createIndexSnapshotRepo("index-live-semantic-drift");
    const generator = path.join(root, GENERATOR_PATH);
    const core = path.join(root, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs");
    const artifactEntries = Object.entries(ARTIFACT_PATHS).filter(([name]) => name !== "post_dossier");
    const baseline = Object.fromEntries(artifactEntries.map(([name, relative]) => [name, fs.readFileSync(path.join(root, relative))]));
    replaceExact(generator, 'selection_hash: "94edfbbdf354c7df5a45337fb29365f67e12c6a792f924805cf874fe1f42ae35"', `selection_hash: "${"a".repeat(64)}"`);
    replaceExact(core, 'export const REVISION = "R4.2";', 'export const REVISION = "R4.2-live-poison";');
    const registryBefore = worktreeRegistry(root);
    const env = { ...process.env, PI_ASTACK_R42_INDEX_SNAPSHOT_CHILD: root };
    const write = spawnSync(process.execPath, [generator, "--write", "--source-snapshot=index"], { cwd: root, encoding: "utf8", env, timeout: 600000 });
    assert(write.status === 0 && parseStrictJson(write.stdout).source_snapshot === "index", write.stderr || "isolated index write failed under live drift");
    for (const [name, relative] of artifactEntries) {
      assert(fs.readFileSync(path.join(root, relative)).equals(baseline[name]), `${name} live bytes changed under unstaged semantic drift`);
      assert(requireGit(root, ["cat-file", "blob", `:${relative}`], `cannot read staged ${name}`).equals(baseline[name]), `${name} staged bytes changed under unstaged semantic drift`);
    }
    assert(spawnSync("git", ["-C", root, "diff", "--quiet", "--", GENERATOR_PATH, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs"]).status === 1, "live semantic drift was not retained as unstaged dirt");
    assert(spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", GENERATOR_PATH, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.2-core.mjs"]).status === 0, "index semantic sources were changed by write");
    const verify = spawnSync(process.execPath, [generator, "--verify", "--source-snapshot=index"], { cwd: root, encoding: "utf8", env, timeout: 600000 });
    assert(verify.status === 0 && parseStrictJson(verify.stdout).source_snapshot === "index", verify.stderr || "isolated index verify failed under live drift");
    assert(worktreeRegistry(root).equals(registryBefore), "index execution leaked a detached worktree registration");
  });

  await check("nonartifact index drift during the artifact copy/stage window fails the complete expected-index comparison", () => {
    const root = createIndexSnapshotRepo("index-nonartifact-drift");
    const generator = path.join(root, GENERATOR_PATH);
    const indexPath = path.join(root, ".git", "index");
    const driftIndexPath = path.join(tmp, "nonartifact-drift-index");
    fs.copyFileSync(indexPath, driftIndexPath);
    const replacementOid = requireGit(root, ["rev-parse", `HEAD:${GENERATOR_PATH}`], "cannot resolve nonartifact drift blob").toString("utf8").trim();
    const drift = spawnSync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `100644,${replacementOid},README.md`], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: driftIndexPath },
    });
    assert(drift.status === 0, drift.stderr || "cannot construct nonartifact drift index");
    const triggerPath = path.join(root, ARTIFACT_PATHS.source_manifest);
    const preloadPath = path.join(tmp, "inject-index-drift.cjs");
    fs.writeFileSync(preloadPath, `const fs = require("node:fs");\nconst path = require("node:path");\nconst original = fs.writeFileSync;\nlet fired = false;\nfs.writeFileSync = function(file, ...args) {\n  const result = original.call(fs, file, ...args);\n  if (!fired && typeof file !== "number" && path.resolve(String(file)) === ${JSON.stringify(triggerPath)}) {\n    fired = true;\n    original.call(fs, ${JSON.stringify(indexPath)}, fs.readFileSync(${JSON.stringify(driftIndexPath)}));\n  }\n  return result;\n};\n`);
    const indexBefore = fs.readFileSync(indexPath);
    const artifactIndexBefore = Object.fromEntries(Object.entries(ARTIFACT_PATHS).filter(([name]) => name !== "post_dossier").map(([name, relative]) => [name, requireGit(root, ["cat-file", "blob", `:${relative}`], `cannot capture staged ${name}`)]));
    const registryBefore = worktreeRegistry(root);
    const result = spawnSync(process.execPath, [generator, "--write", "--source-snapshot=index"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
      timeout: 600000,
    });
    assert(result.status !== 0 && /index changed while generated artifacts were being copied/.test(result.stderr), `nonartifact index drift unexpectedly succeeded: ${result.stdout}${result.stderr}`);
    assert(!fs.readFileSync(indexPath).equals(indexBefore), "drift injector did not change the repository index");
    for (const [name, relative] of Object.entries(ARTIFACT_PATHS).filter(([artifactName]) => artifactName !== "post_dossier")) {
      assert(requireGit(root, ["cat-file", "blob", `:${relative}`], `cannot re-read staged ${name}`).equals(artifactIndexBefore[name]), `${name} index entry changed despite nonartifact drift failure`);
    }
    assert(worktreeRegistry(root).equals(registryBefore), "drifted index write leaked a detached worktree registration");
  });

  await check("index verify reads staged artifact bytes and cleans detached worktree after poisoned failure", () => {
    const root = createIndexSnapshotRepo("index-artifact-poison");
    const generator = path.join(root, GENERATOR_PATH);
    const relative = ARTIFACT_PATHS.source_manifest;
    const artifact = path.join(root, relative);
    const baseline = fs.readFileSync(artifact);
    fs.writeFileSync(artifact, Buffer.concat([baseline, Buffer.from(" ")]));
    requireGit(root, ["add", "--", relative], "cannot stage poisoned artifact");
    fs.writeFileSync(artifact, baseline);
    assert(!requireGit(root, ["cat-file", "blob", `:${relative}`], "cannot read poisoned index artifact").equals(fs.readFileSync(artifact)), "poison fixture did not separate index and live artifact bytes");
    const registryBefore = worktreeRegistry(root);
    const env = { ...process.env, PI_ASTACK_R42_INDEX_SNAPSHOT_CHILD: "untrusted-inherited-marker" };
    const verify = spawnSync(process.execPath, [generator, "--verify", "--source-snapshot=index"], { cwd: root, encoding: "utf8", env, timeout: 600000 });
    assert(verify.status !== 0 && /source_manifest bytes differ from content-only rebuild/.test(verify.stderr), `poisoned index artifact unexpectedly verified: ${verify.stdout}${verify.stderr}`);
    assert(worktreeRegistry(root).equals(registryBefore), "failed index verify leaked a detached worktree registration");
  });

  await check("real resolver recognizes exact R4.2 settings and selects zero when terminal I/V/R is absent", async () => {
    const shared = await loadTypescriptModule("extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts");
    const control = await loadTypescriptModule("extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts");
    const contract = artifactBundle.values.static_contract;
    const desired = renderDesiredSubtree(contract.settings_contract.desired_v2_template, contract.static_contract_hash, h("resolver-token"));
    const settings = shared.resolveD3V2SessionStartInjectionSettings(desired);
    assert(shared.isD3V2R42SettingsBinding(settings.r4Binding), "settings resolver did not retain exact R4.2 binding");
    const mixed = structuredClone(desired); mixed.r4Binding.foreign = true;
    expectFailure(() => shared.resolveD3V2SessionStartInjectionSettings(mixed), ["r4Binding keys differ"]);
    const decision = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: tmp,
      settings,
      sessionManager: { getSessionId: () => contract.target_session_binding.session_id, getSessionFile: () => contract.target_session_binding.session_file.path },
      currentSystemPrompt: "base prompt",
    });
    assert(decision.kind === "selected_zero_injection" && decision.selection.selected === true, "R4.2 no-terminal path was not selected-zero");
    assert(decision.reason !== "r4_runtime_gate_required" && decision.reason !== "adapter_manifest_mismatch", "R4.2 fell through a legacy runtime gate");
  });

  await check("strict JSON rejects BOM, UTF-16, invalid UTF-8, comments, trailing comma/input, duplicate decoded key, lone surrogate and non-finite number", () => {
    const cases = [
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), Buffer.from([0xff, 0xfe, 0x7b, 0]), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      '{"a":1}//x', '{"a":1,}', '{"a":1}x', '{"a":1,"\\u0061":2}', '{"x":"\\ud800"}', '{"x":1e999}',
    ];
    for (const raw of cases) expectFailure(() => parseStrictJson(raw));
    assert(canonicalizeJcs(parseStrictJson('{"b":2,"a":1}')) === '{"a":1,"b":2}');
  });

  await check("strict JSON and canonical object bounds reject N+1 while accepting N", () => {
    const exact = Buffer.from(`"${"x".repeat(MAX_OBJECT_BYTES - 2)}"`);
    assert(exact.length === MAX_OBJECT_BYTES && parseStrictJson(exact, { maxBytes: MAX_OBJECT_BYTES }).length === MAX_OBJECT_BYTES - 2);
    expectFailure(() => parseStrictJson(Buffer.concat([exact, Buffer.from(" ")]), { maxBytes: MAX_OBJECT_BYTES }), ["OVERSIZE"]);
  });

  await check("trusted pi v3 retained transcript validates exact header, closed entry schema, root chain and frozen prefix", () => {
    const root = path.join(tmp, "trusted-transcript"); fs.mkdirSync(root, { mode: 0o700 });
    const binding = sessionFile(root, "trusted-session", "trusted-session");
    const retained = openRetainedTranscript(binding);
    try { const boundary = retained.boundary(); assert(boundary.prefix_bytes > 0 && /^[0-9a-f]{64}$/.test(boundary.prefix_sha256)); }
    finally { retained.close(); }
    const raw = fs.readFileSync(binding.session_file.path, "utf8");
    const bad = raw.replace('"type":"model_change"', '"type":"unknown_future_type"');
    fs.writeFileSync(binding.session_file.path, bad, { mode: 0o600 });
    expectFailure(() => openRetainedTranscript(binding), ["PREFIX", "ENTRY_TYPE"]);
  });

  await check("latest role=user authorization remains valid with a legal assistant/tool transcript tail", () => {
    const root = path.join(tmp, "trusted-user-tail"); fs.mkdirSync(root, { mode: 0o700 });
    const binding = sessionFile(root, "trusted-user-tail", "trusted-user-tail");
    const rows = fs.readFileSync(binding.session_file.path, "utf8").trimEnd().split("\n").map(JSON.parse);
    const text = "exact runtime authorization candidate"; const now = Date.now();
    const user = { type: "message", id: h("tail-user").slice(0, 16), parentId: rows.at(-1).id, timestamp: new Date(now - 2_000).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: now - 2_000 } };
    const assistant = { type: "message", id: h("tail-assistant").slice(0, 16), parentId: user.id, timestamp: new Date(now - 1_000).toISOString(), message: { role: "assistant", content: [], timestamp: now - 1_000, api: "fixture", provider: "fixture", model: "fixture", usage: {}, stopReason: "toolUse" } };
    const tool = { type: "message", id: h("tail-tool").slice(0, 16), parentId: assistant.id, timestamp: new Date(now - 500).toISOString(), message: { role: "toolResult", content: [], timestamp: now - 500, toolCallId: "call-1", toolName: "fixture", isError: false } };
    fs.appendFileSync(binding.session_file.path, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n${JSON.stringify(tool)}\n`);
    const retained = openRetainedTranscript(binding);
    try {
      const coordinate = retained.verifyLatestExact({ exactText: text });
      assert(coordinate.message_id === user.id && retained.boundary().latest_line > coordinate.message_line_number);
    } finally { retained.close(); }
  });

  await check("temp inode ctime raises the post-creation authorization floor for dedicated disposition", () => {
    const file = path.join(tmp, "progress-floor"); fs.writeFileSync(file, "x", { mode: 0o600 }); const stat = fs.lstatSync(file);
    const floor = progressRequiredAfter({ message_line_number: 7, timestamp: new Date(0).toISOString(), transcript_prefix_bytes: 10 }, { inventory: { rows: [{ path: file }], settings_temps: [] } }, null);
    assert(floor.line === 7 && floor.prefix_bytes === 10 && Date.parse(floor.timestamp) >= Math.floor(stat.ctimeMs), "durable progress was not included in authorization freshness floor");
  });

  await check("bigint nanosecond identity preserves sec/nsec boundaries and rejects unsafe/negative values", () => {
    const fake = { dev: 1n, ino: 2n, mode: 0o100600n, uid: 1000n, gid: 1000n, nlink: 1n, size: 1n, mtimeNs: 1_999_999_999n, ctimeNs: 2_000_000_000n };
    const identity = fullIdentityFromBigintStat(fake, Buffer.from("x"));
    assert(identity.mtime_sec === 1 && identity.mtime_nsec === 999999999 && identity.ctime_sec === 2 && identity.ctime_nsec === 0);
    validateFullIdentity(identity);
    expectFailure(() => fullIdentityFromBigintStat({ ...fake, mtimeNs: -1n }, Buffer.from("x")), ["TIME"]);
    expectFailure(() => validateFullIdentity({ ...identity, mtime_nsec: 1000000000 }), ["SAFE_INTEGER"]);
  });

  await check("static hash retains both nested sentinels and persisted rendering removes both at fixed paths", () => {
    const contract = artifactBundle.values.static_contract;
    assert(canonicalizeJcs(contract.settings_contract.desired_v2_template.r4Binding.static_contract_hash) === canonicalizeJcs(STATIC_SENTINEL));
    assert(canonicalizeJcs(contract.settings_contract.desired_v2_template.r4Binding.commit_token) === canonicalizeJcs(DYNAMIC_SENTINEL));
    const token = h("token");
    const desired = renderDesiredSubtree(contract.settings_contract.desired_v2_template, contract.static_contract_hash, token);
    assert(desired.r4Binding.static_contract_hash === contract.static_contract_hash && desired.r4Binding.commit_token === token);
    const bad = structuredClone(contract); bad.settings_contract.desired_v2_template.r4Binding.static_contract_hash = contract.static_contract_hash;
    delete bad.static_contract_hash; bad.static_contract_hash = jcsSha256(bad);
    expectFailure(() => validateStaticContract(bad), ["SENTINEL"]);
  });

  await check("commit token binds exact domain/order/NUL/pre_raw/static/coordinate/source/target and excludes B/op/receipt", () => {
    const args = { staticContractHash: h("static"), coordinateHash: h("coordinate"), preRaw: Buffer.from('{"x":1}\n'), sourceCommit: "1".repeat(40), targetSessionId: "target" };
    const token = computeCommitToken(args);
    for (const changed of [{ staticContractHash: h("static2") }, { coordinateHash: h("coordinate2") }, { preRaw: Buffer.from('{"x":1} \n') }, { sourceCommit: "2".repeat(40) }, { targetSessionId: "target2" }]) assert(computeCommitToken({ ...args, ...changed }) !== token, "token did not bind changed field");
  });

  await check("control bootstrap advances only B0->B1->B2->B3->B4 with guard before every mkdir/fsync", () => {
    const root = path.join(tmp, "bootstrap", "control"); fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    const calls = []; const result = bootstrapControl({ controlRoot: root, guard(name) { calls.push(name); return true; } });
    assert(result.state === "root_plus_intents_activations_receipts"); result.root.close();
    assert(calls.length === 8 && calls.every((name) => name.includes("mkdir") || name.includes("fsync")), calls.join(","));
    fs.writeFileSync(path.join(root, "foreign"), "x");
    expectFailure(() => bootstrapControl({ controlRoot: root, guard: () => true }), ["SHAPE"]);
  });

  await check("R4.2 staged publication uses unique temp -> canonical pending -> final and guard precedes every mutation", () => {
    const dir = path.join(tmp, "staged-positive"); fs.mkdirSync(dir, { mode: 0o700 });
    const parent = openAnchoredDirectory(dir, { mode: 0o700, uid: process.getuid(), gid: process.getgid() });
    try {
      const id = h("staged-op"); const kind = "intent"; const nonce = "a".repeat(32);
      const value = addSelfHash({ schema_version: "fixture/v1", value: 1 }, "object_hash");
      const bytes = canonicalObjectBytes(value, "object_hash"); const guards = [];
      const staged = stagedPublish({ schema: SCHEMAS.staged_publish, parent, operationId: id, kind, finalBasename: `${id}.json`, pendingBasename: pendingBasename(id, kind), tempBasename: stagedTempBasename(id, kind, nonce), nonce, bytes, guard(name) { guards.push(name); return true; } });
      assert(staged.status === "canonical_pending" && fs.lstatSync(path.join(dir, pendingBasename(id, kind))).nlink === 1);
      const converged = convergePendingToFinal({ parent, finalBasename: `${id}.json`, pendingBasename: pendingBasename(id, kind), bytes, guard(name) { guards.push(name); return true; } });
      assert(converged.status === "final_only" && fs.lstatSync(path.join(dir, `${id}.json`)).nlink === 1);
      assert(guards.length >= 10, "per-syscall guards missing");
    } finally { parent.close(); }
  });

  await check("staged publication crash before pending leaves nonauthority temp; corrupt deterministic pending is never adopted", () => {
    const dir = path.join(tmp, "staged-crash"); fs.mkdirSync(dir, { mode: 0o700 });
    const parent = openAnchoredDirectory(dir, { mode: 0o700, uid: process.getuid(), gid: process.getgid() });
    const id = h("staged-crash-op"); const nonce = "b".repeat(32); const value = addSelfHash({ schema_version: "fixture/v1", value: 2 }, "object_hash"); const bytes = canonicalObjectBytes(value, "object_hash");
    try {
      expectFailure(() => stagedPublish({ schema: SCHEMAS.staged_publish, parent, operationId: id, kind: "intent", finalBasename: `${id}.json`, pendingBasename: pendingBasename(id, "intent"), tempBasename: stagedTempBasename(id, "intent", nonce), nonce, bytes, guard: () => true, afterMutation({ syscall }) { if (syscall === "fsync_temp") throw new Error("simulated crash"); } }), ["simulated crash"]);
      assert(fs.existsSync(path.join(dir, stagedTempBasename(id, "intent", nonce))) && !fs.existsSync(path.join(dir, pendingBasename(id, "intent"))));
      const residue = expectFailure(() => stagedPublish({ schema: SCHEMAS.staged_publish, parent, operationId: id, kind: "intent", finalBasename: `${id}.json`, pendingBasename: pendingBasename(id, "intent"), tempBasename: stagedTempBasename(id, "intent", nonce), nonce, bytes, guard: () => true }), ["STAGED_TEMP_EEXIST"]);
      assert(residue.status === "ZERO_WRITE_HALT" && residue.mutationCount === 0, "staged temp EEXIST lacked explicit R4.2 halt status");
      fs.writeFileSync(path.join(dir, pendingBasename(h("corrupt"), "intent")), "");
      expectFailure(() => stagedPublish({ schema: SCHEMAS.staged_publish, parent, operationId: h("corrupt"), kind: "intent", finalBasename: `${h("corrupt")}.json`, pendingBasename: pendingBasename(h("corrupt"), "intent"), tempBasename: stagedTempBasename(h("corrupt"), "intent", "c".repeat(32)), nonce: "c".repeat(32), bytes, guard: () => true }), ["PENDING_EXISTS"]);
    } finally { parent.close(); }
  });

  await check("link EEXIST and unlink ENOENT converge only for exact retained inode/bytes states", () => {
    const dir = path.join(tmp, "idempotent"); fs.mkdirSync(dir, { mode: 0o700 });
    const parent = openAnchoredDirectory(dir, { mode: 0o700, uid: process.getuid(), gid: process.getgid() });
    try {
      const id = h("idempotent-op"); const pending = pendingBasename(id, "receipt"); const final = `${id}.json`; const bytes = Buffer.from('{"x":1}\n');
      fs.writeFileSync(path.join(dir, pending), bytes, { mode: 0o600 });
      linkFinalIdempotent({ schema: SCHEMAS.link_final, parent, finalBasename: final, pendingBasename: pending, bytes, guard: () => true });
      const again = linkFinalIdempotent({ schema: SCHEMAS.link_final, parent, finalBasename: final, pendingBasename: pending, bytes, guard: () => true });
      assert(again.status === "final_plus_pending");
      unlinkPendingIdempotent({ schema: SCHEMAS.unlink_pending, parent, finalBasename: final, pendingBasename: pending, bytes, guard: () => true });
      const absentAgain = unlinkPendingIdempotent({ schema: SCHEMAS.unlink_pending, parent, finalBasename: final, pendingBasename: pending, bytes, guard: () => true });
      assert(absentAgain.status === "final_only");
    } finally { parent.close(); }
  });

  await check("full fixture execute publishes I/V, CASes only v2 with metadata preservation, and publishes direct R", () => {
    const f = makeFixture("execute-happy", artifactBundle.values.static_contract); grantInitial(f);
    const beforeStat = fs.lstatSync(f.settingsPath);
    const result = executeFixture({ ...f.baseArgs, nonces: { intent: "1".repeat(32), activation: "2".repeat(32), settings: "3".repeat(32), receipt: "4".repeat(32) } });
    assert(result.status === "bound" && result.mode === "direct");
    const terminal = verifyTerminalFixture(f.contract);
    assert(terminal.receipt.mode === "direct" && terminal.settings_state === "B");
    const afterStat = fs.lstatSync(f.settingsPath);
    assert((afterStat.mode & 0o7777) === (beforeStat.mode & 0o7777) && afterStat.uid === beforeStat.uid && afterStat.gid === beforeStat.gid);
    const after = parseStrictJson(fs.readFileSync(f.settingsPath));
    const before = parseStrictJson(f.initialSettings);
    delete after.ruleInjector["propositionLifecycleFreshnessD3V2SessionStartInjection"];
    assert(canonicalizeJcs(after) === canonicalizeJcs(before), "non-v2 semantics changed");
  });

  await check("fixture authorization mismatch halts before bootstrap/temp/settings mutation", () => {
    const f = makeFixture("auth-mismatch", artifactBundle.values.static_contract);
    f.authorization.grant("wrong phrase");
    const settingsBefore = fs.readFileSync(f.settingsPath);
    expectFailure(() => executeFixture(f.baseArgs), ["authorization mismatch"]);
    assert(!fs.existsSync(f.controlRoot) && fs.readFileSync(f.settingsPath).equals(settingsBefore));
  });

  await check("per-syscall source drift prevents target syscall and reports honest partial mutation boundary", () => {
    const f = makeFixture("source-drift", artifactBundle.values.static_contract); grantInitial(f);
    let calls = 0;
    const error = expectFailure(() => executeFixture({ ...f.baseArgs, sourceGuard() { calls += 1; return calls < 4; } }), ["SOURCE_GUARD"]);
    assert(calls === 4 && !fs.existsSync(path.join(f.controlRoot, "intents")), `unexpected source-guard mutation state ${error}`);
  });

  await check("invocation mutation accounting preserves ZERO_WRITE_HALT versus NO_FURTHER_WRITE across helper boundaries", () => {
    const zero = createInvocationMutationTracker(); const zeroError = new Error("zero"); zero.attach(zeroError); assert(zeroError.status === "ZERO_WRITE_HALT" && zeroError.mutationCount === 0);
    const partial = createInvocationMutationTracker(); partial.bindOperationId(h("tracked-op")); partial.bindCoordinateHash(h("tracked-coordinate")); partial.afterMutation(); partial.afterMutation(); const partialError = new Error("partial"); partial.attach(partialError); assert(partialError.status === "NO_FURTHER_WRITE" && partialError.mutationCount === 2 && partialError.operationId === h("tracked-op") && partialError.coordinateHash === h("tracked-coordinate"));
  });

  await check("CAS->receipt crash recovers exact B through later continue without recapturing A", () => {
    const f = makeFixture("continue-direct", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_settings_parent") throw new Error("crash-after-CAS"); } }), ["crash-after-CAS"]);
    assert(verifyTerminalFailure(f));
    grantContinue(f);
    const result = continueFixture(f.baseArgs);
    assert(result.status === "bound" && result.mode === "direct" && verifyTerminalFixture(f.contract).settings_state === "B");
  });

  await check("shared continue FSM converges canonical I/p to I then V/B/direct R", () => {
    const f = makeFixture("continue-I-p", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation: crashOnAuthorityState(f, "intent", "pending") }), ["crash-intent-pending"]);
    assert(authorityRow(f, "intent", "pending").nlink === 1 && !scanControlInventory(f.contract).rows.some((row) => row.kind === "intent" && row.role === "final"));
    grantContinue(f);
    const result = continueFixture(f.baseArgs);
    assert(result.status === "bound" && verifyTerminalFixture(f.contract).settings_state === "B");
  });

  await check("shared continue FSM converges exact I+I/p same-inode pair", () => {
    const f = makeFixture("continue-I-plus-I-p", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation: crashOnAuthorityState(f, "intent", "final") }), ["crash-intent-final"]);
    const inventory = scanControlInventory(f.contract); const final = inventory.rows.find((row) => row.kind === "intent" && row.role === "final"); const pending = inventory.rows.find((row) => row.kind === "intent" && row.role === "pending");
    assert(final && pending && final.dev === pending.dev && final.ino === pending.ino && final.nlink === 2 && pending.nlink === 2);
    grantContinue(f);
    continueFixture(f.baseArgs);
    assert(verifyTerminalFixture(f.contract).settings_state === "B");
  });

  await check("shared continue FSM converges canonical V/p to V", () => {
    const f = makeFixture("continue-V-p", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation: crashOnAuthorityState(f, "activation", "pending") }), ["crash-activation-pending"]);
    assert(authorityRow(f, "activation", "pending").nlink === 1);
    grantContinue(f);
    continueFixture(f.baseArgs);
    assert(verifyTerminalFixture(f.contract).activation.activation_object_hash === authorityRow(f, "activation").parsed.activation_object_hash);
  });

  await check("shared continue FSM converges exact V+V/p same-inode pair", () => {
    const f = makeFixture("continue-V-plus-V-p", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation: crashOnAuthorityState(f, "activation", "final") }), ["crash-activation-final"]);
    const inventory = scanControlInventory(f.contract); const final = inventory.rows.find((row) => row.kind === "activation" && row.role === "final"); const pending = inventory.rows.find((row) => row.kind === "activation" && row.role === "pending");
    assert(final && pending && final.dev === pending.dev && final.ino === pending.ino && final.nlink === 2 && pending.nlink === 2);
    grantContinue(f);
    continueFixture(f.baseArgs);
    assert(verifyTerminalFixture(f.contract).settings_state === "B");
  });

  await check("ordinary continue on C is zero-write adoption preview; B0/A adoption creates deterministic V/R and proves no CAS history", () => {
    const f = makeFixture("adoption", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_settings_parent") throw new Error("crash-before-R"); } }), ["crash-before-R"]);
    const current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.unrelated.after_crash = true; fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    grantContinue(f);
    const before = protectedSnapshot([f.settingsPath, f.controlRoot]);
    const ordinary = continueFixture(f.baseArgs);
    const after = protectedSnapshot([f.settingsPath, f.controlRoot]);
    assert(ordinary.schema_version === SCHEMAS.adoption_preview && canonicalizeJcs(before) === canonicalizeJcs(after), "ordinary continue mutated C preview state");
    const preview = buildAdoptionPreviewFixture(f.baseArgs);
    f.authorization.grant(preview.exact_authorization_phrase);
    const adopted = adoptAmbientStateFixture(f.baseArgs);
    assert(adopted.mode === "ambient_state_adoption" && adopted.cas_A_to_B_history_proven === false);
    assert(verifyTerminalFixture(f.contract).receipt.post_witness.reason === "state_adoption_only_cas_A_to_B_history_not_proven");
  });

  await check("adoption B converges exact expected V/p before publishing adoption receipt", () => {
    const f = makeFixture("adoption-V-p", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation: crashOnAuthorityState(f, "activation", "pending") }), ["crash-activation-pending"]);
    const intent = authorityRow(f, "intent").parsed;
    const current = parseStrictJson(fs.readFileSync(f.settingsPath));
    current.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection = intent.operation_tuple.desired_v2_subtree;
    current.unrelated.ambient = true;
    fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    const preview = buildAdoptionPreviewFixture(f.baseArgs);
    assert(preview.activation_absent === false && authorityRow(f, "activation", "pending").nlink === 1);
    f.authorization.grant(preview.exact_authorization_phrase);
    adoptAmbientStateFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract);
    assert(terminal.receipt.mode === "ambient_state_adoption" && !scanControlInventory(f.contract).rows.some((row) => row.kind === "activation" && row.role === "pending"));
  });

  await check("activation_absent=true authorization cannot substitute for newly visible exact V/p", () => {
    const f = makeFixture("wrong-activation-absent", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) {
      if (syscall === "fsync_parent_after_pending_unlink") {
        const inventory = scanControlInventory(f.contract);
        if (inventory.rows.some((row) => row.kind === "intent" && row.role === "final") && !inventory.rows.some((row) => row.kind === "activation")) throw new Error("stop-after-I");
      }
    } }), ["stop-after-I"]);
    const intent = authorityRow(f, "intent").parsed;
    const current = parseStrictJson(fs.readFileSync(f.settingsPath));
    current.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection = intent.operation_tuple.desired_v2_subtree;
    current.unrelated.ambient = "wrong-absence";
    fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    const absentPreview = buildAdoptionPreviewFixture(f.baseArgs);
    assert(absentPreview.activation_absent === true);
    const activation = buildActivation({ intent, staticContract: f.contract });
    const pending = path.join(f.controlRoot, "activations", `.${intent.operation_id}.activation.pending`);
    fs.writeFileSync(pending, canonicalObjectBytes(activation, "activation_object_hash"), { mode: 0o600 });
    f.authorization.grant(absentPreview.exact_authorization_phrase);
    expectFailure(() => adoptAmbientStateFixture(f.baseArgs), ["authorization mismatch", "AUTH_EXACT"]);
    assert(!scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt"), "wrong activation_absent phrase published R");
  });

  await check("B-like v2 with non-v2 drift is C and ordinary continue never publishes direct R", () => {
    const f = makeFixture("continue-B-nonv2-mismatch", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_settings_parent") throw new Error("stop-after-B"); } }), ["stop-after-B"]);
    const current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.unrelated.non_v2_drift = true;
    fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    grantContinue(f);
    const result = continueFixture(f.baseArgs);
    assert(result.schema_version === SCHEMAS.adoption_preview && !scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt"));
  });

  await check("preview-bound C raw drift invalidates old adoption phrase before receipt publication", () => {
    const f = makeFixture("adoption-drift", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_settings_parent") throw new Error("stop"); } }), ["stop"]);
    let current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.x = 1; fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    const preview = buildAdoptionPreviewFixture(f.baseArgs); f.authorization.grant(preview.exact_authorization_phrase);
    current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.x = 2; fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    expectFailure(() => adoptAmbientStateFixture(f.baseArgs), ["DRIFT", "STATE", "authorization mismatch"]);
    assert(!scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt"));
  });

  await check("receipt pending C/D recovery reuses the same still-fresh exact gate across invocations", () => {
    const f = makeFixture("receipt-cd", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_parent_after_pending_link" && scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt")) throw new Error("crash-after-R-pending"); } }), ["crash-after-R-pending"]);
    const auto = f.authorization.auto(); let savedCoordinate;
    const reusableAuthorization = { ...auto, verify(input) { savedCoordinate ??= auto.verify(input); return savedCoordinate; } };
    const linked = recoverReceiptPendingFixture({ ...f.baseArgs, authorization: reusableAuthorization });
    assert(linked.status === "receipt_final_plus_pending" && scanControlInventory(f.contract).rows.filter((row) => row.kind === "receipt").length === 2, "C/link did not leave exact R+R/p");
    const cleaned = cleanupReceiptFinalPendingFixture({ ...f.baseArgs, authorization: reusableAuthorization });
    assert(cleaned.status === "terminal_verified" && scanControlInventory(f.contract).rows.filter((row) => row.kind === "receipt").length === 1);
  });

  await check("receipt recovery acquires the retained settings OFD lock before classification or mutation", async () => {
    const f = makeFixture("recovery-lock-busy", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_parent_after_pending_link" && scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt")) throw new Error("stop-R-pending"); } }), ["stop-R-pending"]);
    const before = scanControlInventory(f.contract).inventory_hash;
    const holder = spawn("/usr/bin/flock", ["-xn", path.dirname(f.settingsPath), "-c", "echo locked; read release"], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("flock holder did not become ready")), 5_000);
      holder.once("error", reject);
      holder.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    });
    try {
      expectFailure(() => recoverReceiptPendingFixture({ ...f.baseArgs, authorization: f.authorization.auto() }), ["OFD_BUSY"]);
      assert(scanControlInventory(f.contract).inventory_hash === before, "lock-busy recovery changed authority inventory");
    } finally {
      holder.stdin.write("release\n"); holder.stdin.end();
      await new Promise((resolve) => holder.once("close", resolve));
    }
  });

  await check("direct pending with current nonexact B is permanent fail-closed and never becomes adoption", () => {
    const f = makeFixture("direct-pending-C", artifactBundle.values.static_contract); grantInitial(f);
    // Stop immediately after receipt pending publication parent fsync, before final link.
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_parent_after_pending_link" && scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt")) throw new Error("crash-R-pending"); } }), ["crash-R-pending"]);
    const current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.unrelated.drift = true; fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    expectFailure(() => recoverReceiptPendingFixture({ ...f.baseArgs, authorization: f.authorization.auto() }), ["NONEXACT_B"]);
    assert(scanControlInventory(f.contract).rows.some((row) => row.kind === "receipt" && row.role === "pending"));
  });

  await check("prior nlink-1 authority temp requires exact disposition preview/phrase and does not advance operation", () => {
    const f = makeFixture("temp-disposition", artifactBundle.values.static_contract);
    fs.mkdirSync(path.join(f.controlRoot, "intents"), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "activations"), { mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "receipts"), { mode: 0o700 }); fs.chmodSync(f.controlRoot, 0o700);
    const id = h("temp-disposition-op"); const temp = path.join(f.controlRoot, "intents", `.${id}.intent.stage.${"a".repeat(32)}.tmp`); fs.writeFileSync(temp, '{"partial":true}\n', { mode: 0o600 });
    const preview = previewStagedTempDispositionFixture({ ...f.baseArgs, sourceCommit: f.sourceCommit });
    assert(preview.action === "unlink_nonauthority_temp" && preview.pending_relation === "absent");
    f.authorization.grant(preview.exact_authorization_phrase);
    const result = disposeStagedTempFixture(f.baseArgs);
    assert(result.status === "disposed" && result.operation_advanced === false && !fs.existsSync(temp));
  });

  await check("settings_cas_stage disposition is a closed settings variant and cannot carry authority relations", () => {
    const f = makeFixture("settings-temp-disposition", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fdatasync_settings_temp") throw new Error("crash-settings-temp"); } }), ["crash-settings-temp"]);
    const preview = previewStagedTempDispositionFixture(f.baseArgs);
    assert(preview.temp_kind === "settings_cas_stage" && preview.pending_relation === "not_applicable_settings_cas" && preview.final_relation === "settings_target_exact_A");
    assert(scanControlInventory(f.contract).settings_temps.length === 1 && !preview.control_inventory.some((row) => row.kind !== "settings" && row.path === preview.temp_path));
    f.authorization.grant(preview.exact_authorization_phrase);
    const disposed = disposeStagedTempFixture(f.baseArgs);
    assert(disposed.status === "disposed" && scanControlInventory(f.contract).settings_temps.length === 0);
  });

  await check("readable corrupt authority temp inventory records exact raw SHA rather than an unstructured reason", () => {
    const f = makeFixture("corrupt-temp-sha", artifactBundle.values.static_contract);
    fs.mkdirSync(path.join(f.controlRoot, "intents"), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "activations"), { mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "receipts"), { mode: 0o700 }); fs.chmodSync(f.controlRoot, 0o700);
    const id = h("corrupt-temp-op"); const raw = Buffer.from("{not-json\n"); const temp = path.join(f.controlRoot, "intents", `.${id}.intent.stage.${"7".repeat(32)}.tmp`); fs.writeFileSync(temp, raw, { mode: 0o600 });
    const preview = previewStagedTempDispositionFixture(f.baseArgs);
    assert(preview.temp_kind === "intent_stage" && preview.temp_raw_sha256_or_unreadable_reason === sha256(raw) && /^[0-9a-f]{64}$/.test(preview.temp_raw_sha256_or_unreadable_reason));
  });

  await check("runtime immutable per-receipt audit requires process attempt preview/gate and permits no actual injection", () => {
    const f = makeFixture("runtime-audit", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const preview = buildRuntimeEnablePreviewFixture(f.baseArgs);
    assert(/^[0-9a-f]{32}$/.test(preview.attempt_id) && preview.authoritative === false);
    f.authorization.grant(preview.exact_authorization_phrase);
    const result = materializeRuntimeAuditFixture({ ...f.baseArgs, preview, decisionTimeRevalidate() { verifyTerminalFixture(f.contract); } });
    assert(result.status === "allow_one_first_injection_decision" && result.injection_performed === false && fs.existsSync(result.audit_final_path));
    expectFailure(() => materializeRuntimeAuditFixture({ ...f.baseArgs, preview }), ["ATTEMPT"]);
    const object = parseStrictJson(fs.readFileSync(result.audit_final_path)); validateRuntimeAuditObject(object);
    assert(!Object.hasOwn(object, "attempt_id") && !Object.hasOwn(object, "coordinate"));
  });

  await check("same-process runtime roundtrip returns preview/phrase on first turn and allows on the next exact-user turn", () => {
    const f = makeFixture("runtime-roundtrip", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const first = runtimeEnableFixture(f.baseArgs);
    assert(first.status === "runtime_enable_authorization_required" && first.decision === "selected_zero_injection" && first.preview.exact_authorization_phrase === first.exact_authorization_phrase);
    f.authorization.grant(first.exact_authorization_phrase);
    const second = runtimeEnableFixture(f.baseArgs);
    assert(second.status === "allow_one_first_injection_decision" && second.attempt_id === first.preview.attempt_id && second.injection_performed === false);
  });

  await check("runtime materializer rejects a re-self-hashed caller-forged preview before audit mutation", () => {
    const f = makeFixture("runtime-forged-preview", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const preview = buildRuntimeEnablePreviewFixture(f.baseArgs);
    const forged = structuredClone(preview); forged.final_path = `${preview.final_path}.forged`;
    const rehashed = reselfHash(forged, "preview_hash");
    expectFailure(() => materializeRuntimeAuditFixture({ ...f.baseArgs, preview: rehashed }), ["ATTEMPT", "CALLER_PREVIEW"]);
    assert(!fs.existsSync(f.runtimeAuditRoot), "forged preview created runtime audit state");
  });

  await check("runtime audit idempotency is per receipt and existing final still needs a new attempt", () => {
    const f = makeFixture("runtime-existing", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const p1 = buildRuntimeEnablePreviewFixture(f.baseArgs); f.authorization.grant(p1.exact_authorization_phrase); const r1 = materializeRuntimeAuditFixture({ ...f.baseArgs, preview: p1 });
    const p2 = buildRuntimeEnablePreviewFixture(f.baseArgs); assert(p2.attempt_id !== p1.attempt_id && p2.audit_object_hash === p1.audit_object_hash);
    f.authorization.grant(p2.exact_authorization_phrase); const r2 = materializeRuntimeAuditFixture({ ...f.baseArgs, preview: p2 });
    assert(r1.audit_final_path === r2.audit_final_path && r2.injection_performed === false);
  });

  await check("runtime attempt freshness and replay fail before audit mutation", () => {
    const noTerminal = makeFixture("runtime-no-terminal", artifactBundle.values.static_contract);
    expectFailure(() => buildRuntimeEnablePreviewFixture(noTerminal.baseArgs), ["TERMINAL"]);
    const f = makeFixture("runtime-stale", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const preview = buildRuntimeEnablePreviewFixture({ ...f.baseArgs, nowMs: 1_000 }); f.authorization.grant(preview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...f.baseArgs, preview, nowMs: 121_001 }), ["ATTEMPT_STALE"]);
    assert(!fs.existsSync(f.runtimeAuditRoot), "stale runtime attempt created audit state");
  });

  await check("runtime final source guard rejects drift injected during the former post-source terminal/audit window", () => {
    const f = makeFixture("runtime-final-source-last", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const preview = buildRuntimeEnablePreviewFixture(f.baseArgs); f.authorization.grant(preview.exact_authorization_phrase);
    let sourceDrift = false; let finalSourceAttempted = false; let lastSuccessfulSource = null;
    expectFailure(() => materializeRuntimeAuditFixture({
      ...f.baseArgs,
      preview,
      sourceGuard({ syscall }) {
        if (sourceDrift) {
          finalSourceAttempted = syscall === "decision_time_revalidation";
          throw new Error("source drift injected after the prior source check");
        }
        lastSuccessfulSource = syscall;
        return true;
      },
      decisionTimeRevalidate() {
        assert(lastSuccessfulSource === "fsync_runtime_audit_root_final", "drift hook did not run in the post-durability decision window");
        sourceDrift = true;
      },
    }), ["source drift injected after the prior source check"]);
    assert(finalSourceAttempted && fs.existsSync(preview.final_path), "final live source guard did not reject while retaining the durable audit final");
  });

  await check("existing runtime audit final validates before refresh and rejects a refresh-time inode replacement", () => {
    const corrupt = makeFixture("runtime-existing-validate-first", artifactBundle.values.static_contract); grantInitial(corrupt); executeFixture(corrupt.baseArgs);
    const corruptPreview = buildRuntimeEnablePreviewFixture(corrupt.baseArgs);
    fs.mkdirSync(corrupt.runtimeAuditRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(corruptPreview.final_path, '{"bad":true}\n', { mode: 0o600 });
    corrupt.authorization.grant(corruptPreview.exact_authorization_phrase);
    let corruptRefreshGuardSeen = false;
    expectFailure(() => materializeRuntimeAuditFixture({
      ...corrupt.baseArgs,
      preview: corruptPreview,
      sourceGuard({ syscall }) {
        if (syscall === "fdatasync_runtime_audit_final") corruptRefreshGuardSeen = true;
        return true;
      },
    }), ["runtime audit final before refresh", "ANCHORED_BYTES"]);
    assert(!corruptRefreshGuardSeen, "corrupt existing final reached fdatasync before exact anchored validation");

    const swapped = makeFixture("runtime-existing-refresh-inode", artifactBundle.values.static_contract); grantInitial(swapped); executeFixture(swapped.baseArgs);
    const first = buildRuntimeEnablePreviewFixture(swapped.baseArgs); swapped.authorization.grant(first.exact_authorization_phrase); materializeRuntimeAuditFixture({ ...swapped.baseArgs, preview: first });
    const refresh = buildRuntimeEnablePreviewFixture(swapped.baseArgs); swapped.authorization.grant(refresh.exact_authorization_phrase);
    const displacedPath = `${refresh.final_path}.displaced`;
    let replaced = false;
    expectFailure(() => materializeRuntimeAuditFixture({
      ...swapped.baseArgs,
      preview: refresh,
      sourceGuard({ syscall }) {
        if (!replaced && syscall === "fdatasync_runtime_audit_final") {
          const exactRaw = fs.readFileSync(refresh.final_path);
          fs.renameSync(refresh.final_path, displacedPath);
          fs.writeFileSync(refresh.final_path, exactRaw, { mode: 0o600 });
          replaced = true;
        }
        return true;
      },
    }), ["FINAL_INODE", "FINAL_READBACK"]);
    assert(replaced && fs.existsSync(refresh.final_path) && fs.existsSync(displacedPath), "refresh-time inode replacement hook did not execute");
  });

  await check("runtime decision-time gate rejects source, settings and target replacement drift after durable audit", () => {
    const source = makeFixture("runtime-source-drift", artifactBundle.values.static_contract); grantInitial(source); executeFixture(source.baseArgs);
    const sourcePreview = buildRuntimeEnablePreviewFixture(source.baseArgs); source.authorization.grant(sourcePreview.exact_authorization_phrase); let sourceDrift = false;
    expectFailure(() => materializeRuntimeAuditFixture({ ...source.baseArgs, preview: sourcePreview, sourceGuard() { if (sourceDrift) throw new Error("source hash drift"); return true; }, afterMutation({ syscall }) { if (syscall === "fsync_runtime_audit_root_final") sourceDrift = true; } }), ["source hash drift"]);
    assert(fs.existsSync(sourcePreview.final_path), "source-drift attempt did not retain durable audit witness");

    const settings = makeFixture("runtime-settings-drift", artifactBundle.values.static_contract); grantInitial(settings); executeFixture(settings.baseArgs);
    const settingsPreview = buildRuntimeEnablePreviewFixture(settings.baseArgs); settings.authorization.grant(settingsPreview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...settings.baseArgs, preview: settingsPreview, afterMutation({ syscall }) { if (syscall === "fsync_runtime_audit_root_final") fs.writeFileSync(settings.settingsPath, `${canonicalizeJcs({ drift: true })}\n`, { mode: 0o600 }); } }), ["SETTINGS", "current settings"]);

    const target = makeFixture("runtime-target-replace", artifactBundle.values.static_contract); grantInitial(target); executeFixture(target.baseArgs);
    const targetPreview = buildRuntimeEnablePreviewFixture(target.baseArgs); target.authorization.grant(targetPreview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...target.baseArgs, preview: targetPreview, afterMutation({ syscall }) { if (syscall === "fsync_runtime_audit_root_final") { const targetPath = target.targetSessionBinding.session_file.path; const raw = fs.readFileSync(targetPath); fs.renameSync(targetPath, `${targetPath}.replaced`); fs.writeFileSync(targetPath, raw, { mode: 0o600 }); } } }), ["SESSION"]);

    const d3 = makeFixture("runtime-d3-drift", artifactBundle.values.static_contract); grantInitial(d3); executeFixture(d3.baseArgs);
    const d3Preview = buildRuntimeEnablePreviewFixture(d3.baseArgs); d3.authorization.grant(d3Preview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...d3.baseArgs, preview: d3Preview, prepareInjection: () => ({ surface: "old" }), revalidatePrepared() { throw new Error("D3 surface drift"); } }), ["D3 surface drift"]);
    assert(fs.existsSync(d3Preview.final_path), "D3-drift attempt did not retain durable audit witness");
  });

  await check("runtime exact final converges, mismatched final refuses, and temp disposition requires exact key/relation", () => {
    const mismatch = makeFixture("runtime-final-mismatch", artifactBundle.values.static_contract); grantInitial(mismatch); executeFixture(mismatch.baseArgs);
    const badPreview = buildRuntimeEnablePreviewFixture(mismatch.baseArgs); fs.mkdirSync(mismatch.runtimeAuditRoot, { recursive: true, mode: 0o700 }); fs.writeFileSync(badPreview.final_path, '{"bad":true}\n', { mode: 0o600 }); mismatch.authorization.grant(badPreview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...mismatch.baseArgs, preview: badPreview }), ["runtime audit final", "MISMATCH"]);
    assert(!fs.readdirSync(mismatch.runtimeAuditRoot).some((name) => name.startsWith(".")), "mismatched final created a temp");

    const f = makeFixture("runtime-temp-exact", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const runtimePreview = buildRuntimeEnablePreviewFixture(f.baseArgs); const terminal = verifyTerminalFixture(f.contract);
    const audit = buildRuntimeAuditObject({ idempotency_key: runtimePreview.idempotency_key, operation_id: terminal.operation_id, receipt_hash: terminal.receipt.receipt_hash, activation_object_hash: terminal.activation.activation_object_hash, static_contract_hash: terminal.intent.operation_tuple.static_contract_hash, commit_token: terminal.intent.operation_tuple.commit_token, target_session_id: f.contract.target_session_binding.session_id });
    const bytes = canonicalObjectBytes(audit, "audit_object_hash"); fs.mkdirSync(f.runtimeAuditRoot, { recursive: true, mode: 0o700 }); fs.writeFileSync(runtimePreview.final_path, bytes, { mode: 0o600 });
    const temp = path.join(f.runtimeAuditRoot, `.${runtimePreview.idempotency_key}.runtime-audit.stage.${"d".repeat(32)}.tmp`); fs.writeFileSync(temp, bytes, { mode: 0o600 });
    f.authorization.grant(runtimePreview.exact_authorization_phrase);
    expectFailure(() => materializeRuntimeAuditFixture({ ...f.baseArgs, preview: runtimePreview }), ["TEMP_DISPOSITION_REQUIRED"]);
    const disposition = previewRuntimeAuditTempDispositionFixture(f.baseArgs); assert(disposition.final_relation === "exact_expected_separate_inode"); f.authorization.grant(disposition.exact_authorization_phrase);
    const disposed = disposeRuntimeAuditTempFixture(f.baseArgs); assert(disposed.status === "disposed" && !fs.existsSync(temp) && fs.existsSync(runtimePreview.final_path));
    const fresh = buildRuntimeEnablePreviewFixture(f.baseArgs); f.authorization.grant(fresh.exact_authorization_phrase); const allowed = materializeRuntimeAuditFixture({ ...f.baseArgs, preview: fresh }); assert(allowed.status === "allow_one_first_injection_decision");

    const alias = path.join(f.runtimeAuditRoot, `.${runtimePreview.idempotency_key}.runtime-audit.stage.${"e".repeat(32)}.tmp`); fs.linkSync(runtimePreview.final_path, alias);
    expectFailure(() => previewRuntimeAuditTempDispositionFixture(f.baseArgs), ["METADATA", "RELATION"]);
    const aliasAttempt = buildRuntimeEnablePreviewFixture(f.baseArgs); f.authorization.grant(aliasAttempt.exact_authorization_phrase); materializeRuntimeAuditFixture({ ...f.baseArgs, preview: aliasAttempt }); assert(!fs.existsSync(alias), "same-inode runtime audit temp did not converge");
    const foreign = path.join(f.runtimeAuditRoot, `.${h("foreign-runtime-key")}.runtime-audit.stage.${"f".repeat(32)}.tmp`); fs.writeFileSync(foreign, bytes, { mode: 0o600 });
    expectFailure(() => previewRuntimeAuditTempDispositionFixture(f.baseArgs), ["TEMP_KEY"]); fs.unlinkSync(foreign);
  });

  await check("runtime audit object/key formulas reject attempt/parent/chain/extra fields", () => {
    const fields = { operation_id: h("op"), receipt_hash: h("receipt"), activation_object_hash: h("activation"), static_contract_hash: h("static"), commit_token: h("token"), target_session_id: "target" };
    const key = runtimeAuditIdempotencyKey(fields); const object = buildRuntimeAuditObject({ ...fields, idempotency_key: key }); validateRuntimeAuditObject(object);
    for (const extra of ["attempt_id", "parent_hash", "coordinate", "row"]) expectFailure(() => validateRuntimeAuditObject({ ...object, [extra]: "x" }), ["KEYS"]);
  });

  await check("tuple validator independently rejects forged expected B, token, metadata and initial phrase boundary", () => {
    const f = makeFixture("forged-tuple", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const tuple = authorityRow(f, "intent").parsed.operation_tuple;
    const wrongB = structuredClone(tuple); wrongB.expected_B_raw_sha256 = h("forged-expected-B");
    expectFailure(() => validateOperationTupleAgainstStatic(wrongB, f.contract), ["EXPECTED_B"]);
    const wrongToken = structuredClone(tuple); wrongToken.commit_token = h("forged-token"); wrongToken.desired_v2_subtree.r4Binding.commit_token = wrongToken.commit_token;
    expectFailure(() => validateOperationTupleAgainstStatic(wrongToken, f.contract), ["TOKEN", "EXPECTED_B"]);
    const wrongMetadata = structuredClone(tuple); wrongMetadata.prestate_A.full_identity.mode = 0o666;
    expectFailure(() => validateOperationTupleAgainstStatic(wrongMetadata, f.contract), ["METADATA"]);
    const wrongInitial = structuredClone(tuple); wrongInitial.initial_preview_transcript_prefix_sha256 = h("forged-preview-boundary");
    expectFailure(() => validateOperationTupleAgainstStatic(wrongInitial, f.contract), ["INITIAL_PHRASE"]);
  });

  await check("activation validator rejects a forged nonce/hash-input object after attacker recomputes self-hashes", () => {
    const f = makeFixture("forged-activation", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const intent = authorityRow(f, "intent").parsed;
    const forged = structuredClone(authorityRow(f, "activation").parsed);
    forged.activation_nonce = h("forged-activation-nonce");
    forged.activation_hash_inputs.activation_nonce = forged.activation_nonce;
    forged.activation_hash_inputs_hash = jcsSha256(forged.activation_hash_inputs);
    const rehashed = reselfHash(forged, "activation_object_hash");
    expectFailure(() => validateActivationAgainstIntent(rehashed, intent, f.contract), ["ACTIVATION", "NONCE"]);
  });

  await check("direct receipt validator binds post identity mode/uid/gid/nlink/size/hash to tuple A and rebuilt B", () => {
    const f = makeFixture("forged-direct-witness", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract);
    const forged = structuredClone(terminal.receipt); forged.post_witness.actual_B_full_identity.size += 1;
    const rehashed = reselfHash(forged, "receipt_hash");
    expectFailure(() => validateReceiptAgainstClosure(rehashed, terminal.intent, terminal.activation, f.contract), ["DIRECT_IDENTITY"]);
  });

  await check("adoption receipt rejects arbitrary later user coordinate after coordinate and receipt self-hashes are recomputed", () => {
    const f = makeFixture("forged-adoption-coordinate", artifactBundle.values.static_contract); grantInitial(f);
    expectFailure(() => executeFixture({ ...f.baseArgs, afterMutation({ syscall }) { if (syscall === "fsync_settings_parent") throw new Error("stop-before-adoption-R"); } }), ["stop-before-adoption-R"]);
    const current = parseStrictJson(fs.readFileSync(f.settingsPath)); current.unrelated.adopt = "later"; fs.writeFileSync(f.settingsPath, `${canonicalizeJcs(current)}\n`, { mode: 0o600 });
    const preview = buildAdoptionPreviewFixture(f.baseArgs); f.authorization.grant(preview.exact_authorization_phrase); adoptAmbientStateFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract); const old = terminal.receipt.completion_authorization.coordinate;
    const arbitrary = buildFixtureCoordinate({ binding: f.authorizationTranscriptBinding, text: "arbitrary later user text", line: old.message_line_number + 1, timestamp: new Date(Date.parse(old.timestamp) + 1_000).toISOString(), prefixBytes: old.transcript_prefix_bytes + 100 });
    const forged = structuredClone(terminal.receipt); forged.completion_authorization = { kind: "ambient_state_adoption", coordinate: arbitrary, coordinate_hash: arbitrary.coordinate_hash };
    const rehashed = reselfHash(forged, "receipt_hash");
    expectFailure(() => validateReceiptAgainstClosure(rehashed, terminal.intent, terminal.activation, f.contract), ["reconstructed exact adoption phrase", "COMPLETION_BINDING"]);
  });

  await check("receipt closure rejects re-self-hashed source and target-session cross-bindings", () => {
    const f = makeFixture("forged-receipt-closure", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract);
    const source = structuredClone(terminal.receipt); source.source_commit = "1".repeat(40);
    expectFailure(() => validateReceiptAgainstClosure(reselfHash(source, "receipt_hash"), terminal.intent, terminal.activation, f.contract), ["source_commit", "FOREIGN_AUTHORITY"]);
    const session = structuredClone(terminal.receipt); session.target_session_binding = terminal.intent.operation_tuple.authorization_transcript_binding;
    expectFailure(() => validateReceiptAgainstClosure(reselfHash(session, "receipt_hash"), terminal.intent, terminal.activation, f.contract), ["target_session_binding", "FOREIGN_AUTHORITY"]);
  });

  await check("rollback remains a separate three-gate interface; invalid cross-binding is denied", () => {
    const f = makeFixture("rollback-gate", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract);
    const activation = terminal.activation;
    const rollbackBase = { schema_version: SCHEMAS.rollback_authorization, revision: REVISION, operation_id: terminal.operation_id, activation_object_hash: activation.activation_object_hash, static_contract_hash: activation.static_contract_hash, commit_token: activation.commit_token, rollback_face: "heavy", state_root: f.contract.rollback_paths.rollback_root };
    const targetBase = { schema_version: SCHEMAS.production_target_authorization, revision: REVISION, operation_id: terminal.operation_id, settings_path: f.settingsPath, target_session_path: f.targetSessionBinding.session_file.path, quarantine_target: f.quarantineTarget, rollback_root: f.rollbackRoot, control_root: f.controlRoot };
    const rollbackAuthorization = addSelfHash(rollbackBase, "authorization_hash"); const productionTargetAuthorization = addSelfHash(targetBase, "authorization_hash");
    const gate = evaluateRollbackGate({ contract: f.contract, activation, rollbackAuthorization, productionTargetAuthorization });
    assert(gate.authorized === true && gate.materialization_allowed === true);
    const forged = addSelfHash({ ...targetBase, operation_id: h("other") }, "authorization_hash");
    const wrongFace = addSelfHash({ ...rollbackBase, rollback_face: "light" }, "authorization_hash");
    const wrongSchema = addSelfHash({ ...targetBase, schema_version: "foreign/v1" }, "authorization_hash");
    assert(evaluateRollbackGate({ contract: f.contract, activation, rollbackAuthorization, productionTargetAuthorization: forged }).authorized === false);
    assert(evaluateRollbackGate({ contract: f.contract, activation, rollbackAuthorization: wrongFace, productionTargetAuthorization }).authorized === false);
    assert(evaluateRollbackGate({ contract: f.contract, activation, rollbackAuthorization, productionTargetAuthorization: wrongSchema }).authorized === false);
  });

  await check("rollback materialization revalidates sole terminal closure and all three gates before mkdir/fsync", () => {
    const f = makeFixture("rollback-materialize", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract); const activation = terminal.activation;
    const rollbackAuthorization = addSelfHash({ schema_version: SCHEMAS.rollback_authorization, revision: REVISION, operation_id: terminal.operation_id, activation_object_hash: activation.activation_object_hash, static_contract_hash: activation.static_contract_hash, commit_token: activation.commit_token, rollback_face: "heavy", state_root: f.rollbackRoot }, "authorization_hash");
    const productionTargetAuthorization = addSelfHash({ schema_version: SCHEMAS.production_target_authorization, revision: REVISION, operation_id: terminal.operation_id, settings_path: f.settingsPath, target_session_path: f.targetSessionBinding.session_file.path, quarantine_target: f.quarantineTarget, rollback_root: f.rollbackRoot, control_root: f.controlRoot }, "authorization_hash");
    let sourceChecks = 0;
    const result = materializeRollbackFixture({ ...f.baseArgs, activation, rollbackAuthorization, productionTargetAuthorization, sourceGuard() { sourceChecks += 1; return true; } });
    const stat = fs.lstatSync(f.rollbackRoot);
    assert(result.status === "rollback_root_materialized" && stat.isDirectory() && (stat.mode & 0o7777) === 0o700 && fs.readdirSync(f.rollbackRoot).length === 0 && sourceChecks >= 3);
  });

  await check("initial/continue/runtime-style phrase cannot replace rollback three-gate materialization", () => {
    const f = makeFixture("rollback-phrase-substitution", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const terminal = verifyTerminalFixture(f.contract); const activation = terminal.activation;
    const rollbackAuthorization = addSelfHash({ schema_version: SCHEMAS.rollback_authorization, revision: REVISION, operation_id: terminal.operation_id, activation_object_hash: activation.activation_object_hash, static_contract_hash: activation.static_contract_hash, commit_token: activation.commit_token, rollback_face: "heavy", state_root: f.rollbackRoot }, "authorization_hash");
    const productionTargetAuthorization = addSelfHash({ schema_version: SCHEMAS.production_target_authorization, revision: REVISION, operation_id: terminal.operation_id, settings_path: f.settingsPath, target_session_path: f.targetSessionBinding.session_file.path, quarantine_target: f.quarantineTarget, rollback_root: f.rollbackRoot, control_root: f.controlRoot }, "authorization_hash");
    expectFailure(() => materializeRollbackFixture({ ...f.baseArgs, activation, rollbackAuthorization, productionTargetAuthorization, rollbackPhrase: continuePhrase({ operation_id: terminal.operation_id, static_contract_hash: activation.static_contract_hash, source_commit: terminal.source_commit }) }), ["PHRASE_SUBSTITUTION"]);
    assert(!fs.existsSync(f.rollbackRoot));
  });

  await check("post dossier is generated only from complete final I/V/R and preserves adoption/direct witness union", () => {
    const incomplete = makeFixture("post-incomplete", artifactBundle.values.static_contract);
    expectFailure(() => buildPostDossierFixture(incomplete.contract), ["TERMINAL"]);
    const f = makeFixture("post-complete", artifactBundle.values.static_contract); grantInitial(f); executeFixture(f.baseArgs);
    const dossier = buildPostDossierFixture(f.contract);
    assert(dossier.completion_state === "completed" && dossier.receipt_mode === "direct" && dossier.post_witness.actual_B_full_identity_recoverable === true);
  });

  await check("committed six artifacts validate exact JCS/self-hash/projection/raw DAG", () => {
    const bundle = loadAndValidateStaticBundle(repoRoot);
    assert(bundle.contract.value.static_contract_hash === artifactBundle.values.static_contract.static_contract_hash);
    for (const name of Object.keys(artifactBundle.raws)) assert(fs.readFileSync(path.join(repoRoot, ARTIFACT_PATHS[name])).equals(artifactBundle.raws[name]), `${name} committed bytes differ`);
  });

  await check("sourceGuard accepts a clean temporary Git tree with exact generated artifacts and closure bytes", () => {
    const cleanRoot = path.join(tmp, "clean-source-git"); fs.mkdirSync(cleanRoot, { recursive: true, mode: 0o700 });
    for (const row of artifactBundle.values.source_manifest.closure_rows) {
      const source = path.join(repoRoot, row.relative_path); const target = path.join(cleanRoot, row.relative_path);
      const live = fs.readFileSync(source);
      const raw = sha256(live) === row.raw_sha256
        ? live
        : spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `HEAD:${row.relative_path}`], { encoding: "buffer" }).stdout;
      assert(sha256(raw) === row.raw_sha256, `cannot reconstruct manifest row ${row.relative_path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, raw);
    }
    for (const [name, raw] of Object.entries(artifactBundle.raws)) {
      const target = path.join(cleanRoot, ARTIFACT_PATHS[name]); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, raw);
    }
    for (const args of [["init", "-q"], ["config", "user.email", "r42-smoke@example.invalid"], ["config", "user.name", "R42 Smoke"], ["add", "-A"], ["commit", "-qm", "clean r4.2 closure"]]) {
      const result = spawnSync("git", ["-C", cleanRoot, ...args], { encoding: "utf8" }); assert(result.status === 0, result.stderr);
    }
    const bundle = loadAndValidateStaticBundle(cleanRoot); const head = spawnSync("git", ["-C", cleanRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const guarded = sourceGuard(cleanRoot, head, bundle);
    assert(guarded.source_guard_passed === true && guarded.source_commit === head && guarded.paths.length >= artifactBundle.values.source_manifest.file_count);
  });

  await check("authority inventory bound rejects a fourth final/pending/temp entry", () => {
    const f = makeFixture("authority-inventory-bound", artifactBundle.values.static_contract);
    fs.mkdirSync(path.join(f.controlRoot, "intents"), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "activations"), { mode: 0o700 }); fs.mkdirSync(path.join(f.controlRoot, "receipts"), { mode: 0o700 }); fs.chmodSync(f.controlRoot, 0o700);
    for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(f.controlRoot, "intents", `${h(`bound-${index}`)}.json`), "{}\n", { mode: 0o600 });
    expectFailure(() => scanControlInventory(f.contract), ["CONTROL_BOUND"]);
  });

  await check("source guard follows actual HEAD closure cleanliness and rejects caller commit substitution", () => {
    const bundle = loadAndValidateStaticBundle(repoRoot);
    const actual = inspectActualHeadClosure(bundle);
    if (actual.ready) {
      const guarded = sourceGuard(repoRoot, actual.head, bundle);
      assert(guarded.source_guard_passed === true && guarded.source_commit === actual.head && guarded.path_count === actual.paths.length);
    } else expectFailure(() => sourceGuard(repoRoot, actual.head, bundle), ["SHADOW", "BLOB"]);
    expectFailure(() => sourceGuard(repoRoot, null, bundle), ["GIT_COMMIT"]);
    expectFailure(() => sourceGuard(repoRoot, actual.head.slice(0, 12), bundle), ["GIT_COMMIT"]);
    const parent = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD^1^{commit}"], { encoding: "utf8" });
    const wrongFullCommit = parent.status === 0 ? parent.stdout.trim() : "0".repeat(40);
    expectFailure(() => sourceGuard(repoRoot, wrongFullCommit, bundle), [parent.status === 0 ? "SOURCE_HEAD" : "SOURCE_COMMIT_OBJECT"]);
  });

  await check("real production default and initial previews prove clean closure or fail closed without writes", () => {
    const bundle = loadAndValidateStaticBundle(repoRoot);
    const actual = inspectActualHeadClosure(bundle);
    const authorityRoots = [PRODUCTION.control_root, PRODUCTION.rollback_root, PRODUCTION.runtime_audit_root];
    const protectedPaths = [PRODUCTION.settings_path, PRODUCTION.target_session_path, PRODUCTION.authorization_session_path, ...authorityRoots];
    const before = protectedSnapshot(protectedPaths);
    assert(protectedSnapshot(authorityRoots).every((entry) => entry.type === "absent"), "production authority root exists before preview");
    const cli = path.join(repoRoot, "scripts/operate-proposition-lifecycle-freshness-d3-v2-session-start-r4.2.mjs");
    const result = spawnSync(process.execPath, [cli], { cwd: repoRoot, encoding: "utf8", timeout: 600000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    assert(result.status === 0, result.stderr);
    const report = parseStrictJson(result.stdout);
    assert(report.schema_version === SCHEMAS.dynamic_report && report.authoritative === false);
    assert(report.control_readiness.control_root_absent === true && report.control_readiness.rollback_root_absent === true && report.control_readiness.runtime_audit_root_absent === true);
    assert(report.source_readiness.ready === actual.ready && report.source_readiness.source_commit === actual.head, "default preview source readiness differs from actual HEAD closure");
    const initial = spawnSync(process.execPath, [cli, "--initial-preview"], { cwd: repoRoot, encoding: "utf8", timeout: 600000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const initialReport = parseStrictJson(initial.stdout);
    if (actual.ready) {
      assert(initial.status === 0, initial.stderr);
      assert(initialReport.schema_version === SCHEMAS.initial_dynamic_preview && initialReport.authoritative === false);
      assert(initialReport.closure_readiness.ready === true && initialReport.source_commit === actual.head);
      assert(typeof initialReport.exact_authorization_phrase === "string" && initialReport.exact_authorization_phrase.length > 0, "initial preview omitted exact authorization phrase");
    } else {
      assert(bundle.dossier.value.stage_state === "S2_NOT_AUTHORIZED", "dirty closure did not remain S2_NOT_AUTHORIZED");
      assert(initial.status === 2 && initialReport.status === "ZERO_WRITE_HALT" && /^R42_SOURCE_(?:SHADOW|LIVE_BLOB|BLOB)$/.test(initialReport.error_code), `unexpected dirty-closure halt: ${initial.stdout}`);
      assert(/^R42_SOURCE_(?:SHADOW|LIVE_BLOB|BLOB)$/.test(report.source_readiness.reason), `unexpected source readiness reason: ${report.source_readiness.reason}`);
    }
    assert(canonicalizeJcs(before) === canonicalizeJcs(protectedSnapshot(protectedPaths)), "production previews changed protected state");
    assert(protectedSnapshot(authorityRoots).every((entry) => entry.type === "absent"), "production preview materialized an authority root");
  });

  await check("default dynamic report remains independent of unrelated settings bytes and static artifacts stay byte-identical", () => {
    const hashesBefore = Object.fromEntries(Object.entries(ARTIFACT_PATHS).filter(([name]) => name !== "post_dossier").map(([name, relative]) => [name, sha256(fs.readFileSync(path.join(repoRoot, relative)))]));
    const first = buildDynamicReadOnlyReport(repoRoot); const second = buildDynamicReadOnlyReport(repoRoot);
    assert(first.static_contract_hash === second.static_contract_hash && canonicalizeJcs(hashesBefore) === canonicalizeJcs(Object.fromEntries(Object.entries(ARTIFACT_PATHS).filter(([name]) => name !== "post_dossier").map(([name, relative]) => [name, sha256(fs.readFileSync(path.join(repoRoot, relative)))]))));
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function verifyTerminalFailure(f) {
  try { verifyTerminalFixture(f.contract); return false; } catch { return true; }
}

if (failures.length) {
  process.stderr.write(`R4.2 smoke failed: ${failures.length}/${passed + failures.length}\n`);
  process.exitCode = 1;
} else process.stdout.write(`R4.2 smoke passed: ${passed} checks\n`);
