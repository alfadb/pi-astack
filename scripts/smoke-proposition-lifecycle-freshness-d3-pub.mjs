#!/usr/bin/env node
/** ADR0040 D3-PUB production-schema publisher smoke; every publisher write is under /tmp. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertD3PubRuntimeEntryPolicy,
  prepareD3PubCleanExecution,
} from "./proposition-lifecycle-freshness-d3-pub-bootstrap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const previewModule = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-preview.ts"));
const transcript = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-transcript.ts"));
const lockModule = jiti(path.join(repoRoot, "extensions/_shared/retained-directory-ofd-lock.ts"));
const { canonicalizeJcs, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-d3-pub-smoke-"));
const failures = [];
let passed = 0;
let productionPreview;
let capsule;

function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function check(name, operation) {
  try { await operation(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); }
}
async function blocked(operation, codes = null) {
  try { await operation(); throw new Error("expected operation to block"); }
  catch (error) {
    if (error?.message === "expected operation to block") throw error;
    if (codes && !codes.includes(error?.code)) throw new Error(`unexpected block ${error?.code}: ${error?.message}`);
    return error;
  }
}
function canonical(value) { return `${canonicalizeJcs(value)}\n`; }
function copySource(home, source) {
  for (const row of source.rows) {
    const from = path.join("/home/worker/.abrain", ...row.relative_path.split("/"));
    const to = path.join(home, ...row.relative_path.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to); fs.chmodSync(to, 0o600);
  }
}
function makeFixture(label, sourceFixture = null) {
  const root = path.join(tmpRoot, label); const home = path.join(root, "abrain");
  const sediment = path.join(home, ".state/sediment"); const target = path.join(sediment, "proposition-lifecycle-freshness/v2");
  const protectedPath = path.join(root, "protected"); const configPath = path.join(root, "config.json");
  fs.mkdirSync(sediment, { recursive: true, mode: 0o700 }); fs.mkdirSync(protectedPath, { mode: 0o700 });
  fs.writeFileSync(path.join(protectedPath, "sentinel"), "protected\n", { mode: 0o600 });
  fs.writeFileSync(configPath, "config\n", { mode: 0o600 });
  copySource(home, productionPreview.plan.source);
  if (sourceFixture) sourceFixture({ root, home, sediment, target, protectedPath, configPath });
  const capsuleBinding = { relative_path: previewModule.D3_PUB_CAPSULE_RELATIVE, capsule_hash: capsule.capsule_hash, commit_oid: capsule.commit_oid, root_tree_oid: capsule.root_tree_oid, dependency_graph_hash: capsule.dependency_graph.graph_hash, external_tool_manifest_hash: capsule.external_tools.manifest_hash, bootstrap_relative_path: previewModule.D3_PUB_BOOTSTRAP_RELATIVE, self_contained: true };
  const plan = core.buildD3PubStaticPlan({ targetRoot: target, source: productionPreview.plan.source, artifacts: productionPreview.plan.artifacts, sourceCapsule: capsuleBinding, protectedPaths: [protectedPath], configurationPaths: [configPath] });
  const dossier = { session_id: `synthetic-${label}`, dossier_relative_path: "docs/evidence/synthetic-dossier.json", dossier_raw_sha256: sha256Hex(`raw-${label}`), dossier_self_hash: sha256Hex(`self-${label}`) };
  const transcriptRaw = transcript.buildSyntheticD3PubTranscript({ dossier });
  const authorization = transcript.verifySyntheticD3PubRatification({ transcriptRaw, dossier });
  return { root, home, sediment, target, protectedPath, configPath, plan, dossier, transcriptRaw, authorization, capsuleBinding };
}
function executeOptions(fixture, extra = {}) { return { plan: fixture.plan, abrainHome: fixture.home, targetRoot: fixture.target, authorization: fixture.authorization, dossier: fixture.dossier, protectedPaths: [fixture.protectedPath], configurationPaths: [fixture.configPath], ...extra }; }
function freshPlan(fixture, suffix) {
  const plan = core.buildD3PubStaticPlan({ targetRoot: fixture.target, source: productionPreview.plan.source, artifacts: productionPreview.plan.artifacts, sourceCapsule: fixture.capsuleBinding, protectedPaths: [fixture.protectedPath], configurationPaths: [fixture.configPath] });
  const dossier = { session_id: `synthetic-${suffix}`, dossier_relative_path: "docs/evidence/synthetic-dossier.json", dossier_raw_sha256: sha256Hex(`raw-${suffix}`), dossier_self_hash: sha256Hex(`self-${suffix}`) };
  const transcriptRaw = transcript.buildSyntheticD3PubTranscript({ dossier });
  const authorization = transcript.verifySyntheticD3PubRatification({ transcriptRaw, dossier });
  return { ...fixture, plan, dossier, transcriptRaw, authorization };
}
function snapshot(paths) { return core.captureProtectedPrestate(paths); }
function materializeBootstrapFixture(fakeRepo, capsuleInput) {
  fs.mkdirSync(fakeRepo, { recursive: true, mode: 0o700 });
  for (const relative of [previewModule.D3_PUB_EXECUTE_RELATIVE, previewModule.D3_PUB_BOOTSTRAP_RELATIVE, "package.json", "package-lock.json"]) {
    const row = capsuleInput.source_files.find((candidate) => candidate.path === relative);
    assert(row, `capsule fixture omits ${relative}`);
    const file = path.join(fakeRepo, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from(row.raw_base64, "base64"), { mode: 0o600 });
  }
  for (const packageRow of capsuleInput.external_tools.packages) {
    for (const row of packageRow.files) {
      const file = path.join(fakeRepo, ...packageRow.package_root_relative.split("/"), ...row.relative_path.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, Buffer.from(row.raw_base64, "base64"), { mode: row.mode });
      fs.chmodSync(file, row.mode);
    }
  }
  const capsuleFile = path.join(fakeRepo, ...previewModule.D3_PUB_CAPSULE_RELATIVE.split("/"));
  fs.mkdirSync(path.dirname(capsuleFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(capsuleFile, canonical(capsuleInput), { mode: 0o600 });
}

process.stdout.write("ADR0040 D3-PUB execution-ready publisher smoke\n");
try {
  await check("source capsule is deterministic, self-contained, and reconstructs a clean closure", () => {
    const gitBefore = snapshot([path.join(repoRoot, ".git")]);
    capsule = previewModule.buildD3PubSourceCapsule(repoRoot);
    const second = previewModule.buildD3PubSourceCapsule(repoRoot);
    assert(canonicalizeJcs(capsule) === canonicalizeJcs(second), "capsule is nondeterministic");
    previewModule.validateD3PubSourceCapsule(capsule);
    const destination = path.join(tmpRoot, "capsule-clean-tree");
    const rebuilt = previewModule.reconstructD3PubSourceCapsule({ capsule, destination });
    const externalCodeFileCount = capsule.external_tools.packages.reduce((count, row) => count + row.files.length, 0);
    assert(rebuilt.verified && rebuilt.commit_oid === capsule.commit_oid && rebuilt.source_file_count === capsule.source_files.length && rebuilt.external_file_count === externalCodeFileCount && rebuilt.file_count === capsule.source_files.length + externalCodeFileCount);
    assert(externalCodeFileCount === 12 && capsule.external_tools.packages.find((row) => row.name === "jiti").files.length === 10 && capsule.external_tools.packages.find((row) => row.name === "typescript").files.length === 2);
    for (const packageRow of capsule.external_tools.packages) for (const row of packageRow.files) assert(Buffer.from(row.raw_base64, "base64").length === row.bytes && /^[0-9a-f]{64}$/.test(row.sha256), `${packageRow.name}/${row.relative_path} bytes are unbound`);
    const kinds = new Set(capsule.git_objects.map((row) => row.kind));
    assert(kinds.has("blob") && kinds.has("tree") && kinds.has("commit"));
    for (const required of [previewModule.D3_PUB_EXECUTE_RELATIVE, previewModule.D3_PUB_BOOTSTRAP_RELATIVE, "schemas/l1-schema-role-registry.json", "schemas/proposition-policy-stable-view-compile-profile-v1.json", "package.json", "package-lock.json"]) assert(capsule.source_files.some((row) => row.path === required), `capsule omits ${required}`);
    assert(capsule.external_tools.packages.map((row) => `${row.name}@${row.version}`).join(",") === "jiti@2.7.0,typescript@6.0.3");
    assert(capsule.external_tools.node_runtime.observed_exec_path === process.execPath && capsule.external_tools.node_runtime.version === process.version);
    assert(capsule.external_tools.node_runtime.exec_bytes === fs.statSync(process.execPath).size && /^[0-9a-f]{64}$/.test(capsule.external_tools.node_runtime.exec_sha256));
    assert(capsule.external_tools.environment_policy.node_options === "must_be_absent_or_empty" && capsule.external_tools.environment_policy.process_exec_argv === "must_be_empty");
    assert(rebuilt.external_resolution.jiti_entry_resolved_path === "node_modules/jiti/lib/jiti.cjs" && rebuilt.external_resolution.typescript_entry_resolved_path === "node_modules/typescript/lib/typescript.js");
    assert(canonicalizeJcs(gitBefore) === canonicalizeJcs(snapshot([path.join(repoRoot, ".git")])), "live Git changed while building capsule");
  });

  await check("two consecutive clean-tree production previews are deterministic at 3/1/1 and preserve the scoped production surfaces", async () => {
    productionPreview = await previewModule.buildD3PubProductionReadOnlyPreview({ repoRoot, abrainHome: "/home/worker/.abrain", capsule });
    const secondPreview = await previewModule.buildD3PubProductionReadOnlyPreview({ repoRoot, abrainHome: "/home/worker/.abrain", capsule });
    assert(canonicalizeJcs({ capsule: productionPreview.capsule, plan: productionPreview.plan, dossier: productionPreview.dossier, note: productionPreview.note }) === canonicalizeJcs({ capsule: secondPreview.capsule, plan: secondPreview.plan, dossier: secondPreview.dossier, note: secondPreview.note }), "consecutive real previews differ");
    assert(productionPreview.plan.artifacts.counts.input_events === 3);
    assert(productionPreview.plan.artifacts.counts.candidates === 1);
    assert(productionPreview.plan.artifacts.counts.stable_items === 1);
    assert(productionPreview.plan.generation === 0 && productionPreview.plan.selection_seq === 0);
    const rebuiltPlan = core.buildD3PubStaticPlan({
      targetRoot: core.D3_PUB_HARD_ROOT,
      source: productionPreview.plan.source,
      artifacts: productionPreview.plan.artifacts,
      sourceCapsule: productionPreview.plan.source_capsule,
      protectedPaths: [
        "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
        "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
        "/home/worker/.abrain/.state/sediment/proposition-lifecycle-freshness/v1",
      ],
      configurationPaths: ["/home/worker/.pi/agent/pi-astack-settings.json", "/home/worker/.pi/agent/settings.json"],
    });
    assert(canonicalizeJcs(rebuiltPlan) === canonicalizeJcs(productionPreview.plan), "static plan is nondeterministic on the same prestate");
    assert(canonicalizeJcs(productionPreview.productionBefore) === canonicalizeJcs(productionPreview.productionAfter));
    assert(!fs.existsSync(core.D3_PUB_FOREIGN_V1) && !fs.existsSync(core.D3_PUB_HARD_ROOT));
    assert(productionPreview.dossier.default_deny.status === "NOT_AUTHORIZED");
    assert(productionPreview.dossier.assertions.artifacts_built_by_capsule_clean_tree_code === true);
    assert(productionPreview.dossier.zero_write_scope.unchanged === true);
    for (const name of ["production_l1", "publication_roots", "configuration", "live_git"]) assert(productionPreview.dossier.zero_write_scope.before[name].snapshot_hash === productionPreview.dossier.zero_write_scope.after[name].snapshot_hash, `${name} zero-write binding differs`);
  });

  await check("official production CLI is default-denied before any production mutation", () => {
    const before = snapshot([core.D3_PUB_FOREIGN_V1, core.D3_PUB_HARD_ROOT]);
    const result = spawnSync(process.execPath, [path.join(repoRoot, previewModule.D3_PUB_EXECUTE_RELATIVE)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    assert(result.status === 1 && result.stderr.includes("NOT_AUTHORIZED") && result.stderr.includes("FRESH_RATIFICATION_REQUIRED"));
    assert(canonicalizeJcs(before) === canonicalizeJcs(snapshot([core.D3_PUB_FOREIGN_V1, core.D3_PUB_HARD_ROOT])));
  });

  await check("runtime entry policy rejects NODE_OPTIONS, NODE_PATH, and process.execArgv without polluting this process", async () => {
    const execute = path.join(repoRoot, previewModule.D3_PUB_EXECUTE_RELATIVE);
    const cleanEnv = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    const nodeOptions = spawnSync(process.execPath, [execute], { encoding: "utf8", env: { ...cleanEnv, NODE_OPTIONS: "--no-warnings" } });
    const nodePath = spawnSync(process.execPath, [execute], { encoding: "utf8", env: { ...cleanEnv, NODE_PATH: "/tmp/d3-pub-forbidden-node-path" } });
    const execArgv = spawnSync(process.execPath, ["--no-warnings", execute], { encoding: "utf8", env: cleanEnv });
    for (const result of [nodeOptions, nodePath, execArgv]) assert(result.status === 1 && result.stderr.includes("D3_PUB_RUNTIME_POLICY_VIOLATION"), `runtime policy did not reject: ${result.stderr}`);
    await blocked(() => assertD3PubRuntimeEntryPolicy({ environment: { NODE_OPTIONS: "--no-warnings", NODE_PATH: "" }, execArgv: [] }), ["D3_PUB_RUNTIME_POLICY_VIOLATION"]);
    assert((process.env.NODE_OPTIONS ?? "") === "" && (process.env.NODE_PATH ?? "") === "" && process.execArgv.length === 0, "runtime policy smoke polluted the current process");
  });

  await check("--production-publish without a later trusted grant is denied before production mutation", () => {
    const before = snapshot([core.D3_PUB_FOREIGN_V1, core.D3_PUB_HARD_ROOT]);
    const result = spawnSync(process.execPath, [path.join(repoRoot, previewModule.D3_PUB_EXECUTE_RELATIVE), "--production-publish"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 120000 });
    assert(result.status === 1 && result.stderr.includes("D3_PUB_FRESH_RATIFICATION_REQUIRED"), `unexpected production deny: ${result.stderr}`);
    assert(canonicalizeJcs(before) === canonicalizeJcs(snapshot([core.D3_PUB_FOREIGN_V1, core.D3_PUB_HARD_ROOT])));
  });

  await check("builtin bootstrap resolves verified jiti/typescript inside the surviving clean tree and publishes only in /tmp", async () => {
    const prepared = prepareD3PubCleanExecution({ repoRoot });
    try {
      assert(prepared.capsule.capsule_hash === capsule.capsule_hash, "bootstrap loaded a different capsule");
      assert(prepared.externalToolResolution.all_resolved_within_clean_tree === true);
      for (const field of ["jiti_package_json_resolved_path", "jiti_entry_resolved_path", "typescript_package_json_resolved_path", "typescript_entry_resolved_path"]) {
        const relative = path.relative(prepared.cleanTree, prepared.externalToolResolution[field]);
        assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${field} escaped reconstructed clean tree`);
      }
      assert(prepared.externalToolResolution.jiti_entry_resolved_path === path.join(prepared.cleanTree, "node_modules/jiti/lib/jiti.cjs"));
      assert(prepared.externalToolResolution.typescript_entry_resolved_path === path.join(prepared.cleanTree, "node_modules/typescript/lib/typescript.js"));
      const cleanCore = prepared.loadCleanModule("extensions/_shared/proposition-lifecycle-freshness-production-core.ts");
      const fixture = makeFixture("clean-tree-publish");
      const result = await cleanCore.executeD3PubSandboxPublication(executeOptions(fixture));
      assert(result.status === "published");
      const closure = cleanCore.readPublishedD3PubSelection(fixture.target);
      assert(closure.selection.selection_hash === result.selection_hash);
    } finally { prepared.close(); }
  });

  await check("builtin bootstrap rejects live launcher drift before creating a clean tree", async () => {
    const fakeRepo = path.join(tmpRoot, "bootstrap-source-drift-repo");
    materializeBootstrapFixture(fakeRepo, capsule);
    fs.appendFileSync(path.join(fakeRepo, previewModule.D3_PUB_EXECUTE_RELATIVE), "\n// drift\n");
    await blocked(() => prepareD3PubCleanExecution({ repoRoot: fakeRepo, tempParent: fakeRepo }), ["D3_PUB_BOOTSTRAP_SOURCE_DRIFT"]);
    assert(!fs.readdirSync(fakeRepo).some((name) => name.startsWith("pi-astack-d3-pub-clean-execution-")), "bootstrap mutated temp state before drift rejection");
  });

  await check("builtin bootstrap rejects changed jiti code bytes before creating a clean tree", async () => {
    const fakeRepo = path.join(tmpRoot, "bootstrap-external-drift-repo");
    materializeBootstrapFixture(fakeRepo, capsule);
    const jitiRow = capsule.external_tools.packages.find((row) => row.name === "jiti");
    const entry = jitiRow.files.find((row) => row.relative_path === jitiRow.entry_relative_path);
    fs.appendFileSync(path.join(fakeRepo, ...jitiRow.package_root_relative.split("/"), ...entry.relative_path.split("/")), "\n// changed external byte\n");
    await blocked(() => prepareD3PubCleanExecution({ repoRoot: fakeRepo, tempParent: fakeRepo }), ["D3_PUB_EXTERNAL_TOOL_DRIFT"]);
    assert(!fs.readdirSync(fakeRepo).some((name) => name.startsWith("pi-astack-d3-pub-clean-execution-")), "bootstrap created a clean tree before external drift rejection");
  });

  await check("transcript validator rejects preauthorization, stale grant, ambiguous dossier, and explicit revocation", async () => {
    const fixture = makeFixture("ratification-negative");
    const wrong = transcript.buildSyntheticD3PubTranscript({ dossier: fixture.dossier, grantText: "提前授权未来 dossier。" });
    await blocked(() => transcript.verifySyntheticD3PubRatification({ transcriptRaw: wrong, dossier: fixture.dossier }), ["D3_PUB_FRESH_RATIFICATION_REQUIRED"]);
    const stale = `${fixture.transcriptRaw}${JSON.stringify({ type: "message", id: "new-dossier", parentId: "grant-user", timestamp: "2030-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: transcript.dossierTranscriptMarker(fixture.dossier) }] } })}\n`;
    await blocked(() => transcript.verifySyntheticD3PubRatification({ transcriptRaw: stale, dossier: fixture.dossier }), ["D3_PUB_AUTHORIZATION_STALE_AFTER_DOSSIER"]);
    const revoked = transcript.buildSyntheticD3PubTranscript({ dossier: fixture.dossier, extraRows: [{ type: "message", id: "revoke-user", parentId: "grant-user", timestamp: "2030-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "撤销当前发布。" }] } }] });
    await blocked(() => transcript.verifySyntheticD3PubRatification({ transcriptRaw: revoked, dossier: fixture.dossier }), ["D3_PUB_AUTHORIZATION_REVOKED"]);
  });

  await check("active-leaf transcript parsing supports branches, string content, and non-message entries while ignoring an abandoned grant", async () => {
    const fixture = makeFixture("ratification-tree");
    const marker = transcript.dossierTranscriptMarker(fixture.dossier);
    const rows = [
      { type: "session", version: 3, id: fixture.dossier.session_id, timestamp: "2030-01-01T00:00:00.000Z" },
      { type: "message", id: "root-dossier", parentId: null, timestamp: "2030-01-01T00:00:01.000Z", message: { role: "assistant", content: marker } },
      { type: "message", id: "abandoned-grant", parentId: "root-dossier", timestamp: "2030-01-01T00:00:02.000Z", message: { role: "user", content: transcript.D3_PUB_GRANT_PHRASE } },
      { type: "message", id: "abandoned-assistant", parentId: "abandoned-grant", timestamp: "2030-01-01T00:00:03.000Z", message: { role: "assistant", content: "old branch" } },
      { type: "branch_summary", id: "branch-summary", parentId: "root-dossier", timestamp: "2030-01-01T00:00:04.000Z", fromId: "abandoned-assistant", summary: "redacted branch summary" },
      { type: "message", id: "tool-row", parentId: "branch-summary", timestamp: "2030-01-01T00:00:05.000Z", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
      { type: "custom", id: "custom-row", parentId: "tool-row", timestamp: "2030-01-01T00:00:06.000Z", customType: "smoke", data: { ok: true } },
      { type: "compaction", id: "compaction-row", parentId: "custom-row", timestamp: "2030-01-01T00:00:07.000Z", summary: "redacted compaction", firstKeptEntryId: "root-dossier", tokensBefore: 10 },
      { type: "message", id: "active-grant", parentId: "compaction-row", timestamp: "2030-01-01T00:00:08.000Z", message: { role: "user", content: transcript.D3_PUB_GRANT_PHRASE } },
      { type: "custom_message", id: "active-leaf", parentId: "active-grant", timestamp: "2030-01-01T00:00:09.000Z", customType: "smoke", content: "post-grant status", display: false },
    ];
    const raw = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const auth = transcript.verifySyntheticD3PubRatification({ transcriptRaw: raw, dossier: fixture.dossier });
    assert(auth.dossier_assistant_message_id === "root-dossier" && auth.grant_user_message_id === "active-grant");
    assert(auth.dossier_assistant_turn_ordinal === 1 && auth.grant_user_turn_ordinal === 2);
    const revoked = `${raw}${JSON.stringify({ type: "message", id: "active-revoke", parentId: "active-leaf", timestamp: "2030-01-01T00:00:10.000Z", message: { role: "user", content: "撤销当前发布。" } })}\n`;
    await blocked(() => transcript.verifySyntheticD3PubRatification({ transcriptRaw: revoked, dossier: fixture.dossier, recorded: auth }), ["D3_PUB_AUTHORIZATION_REVOKED"]);
  });

  await check("real pi session parser locates the current active leaf without requiring a grant", () => {
    const sessionPath = "/home/worker/.pi/agent/sessions/--home-worker-.pi--/2026-07-16T13-16-00-272Z_019f6b11-db90-7128-b1bd-b602b2a87a9c.jsonl";
    const parsed = transcript.inspectTrustedD3PubSession({ sessionPath, expectedSessionId: previewModule.D3_PUB_SESSION_ID });
    assert(parsed.parsed === true && parsed.session_id === previewModule.D3_PUB_SESSION_ID && parsed.entry_count >= parsed.active_branch_entry_count && parsed.active_branch_entry_count > 0);
  });

  await check("fresh natural-language ratification binds message IDs, turn ordinals, prefix, parent chain, raw bytes, and dossier", () => {
    const fixture = makeFixture("ratification-positive");
    const auth = fixture.authorization;
    assert(auth.dossier_assistant_message_id === "dossier-assistant" && auth.grant_user_message_id === "grant-user");
    assert(auth.dossier_assistant_turn_ordinal === 1 && auth.grant_user_turn_ordinal === 2);
    assert(auth.dossier_assistant_native_turn_id === 7 && auth.grant_user_native_turn_id === 8);
    for (const field of ["dossier_assistant_raw_sha256", "grant_user_raw_sha256", "transcript_prefix_hash", "message_parent_chain_hash", "coordinate_hash"]) assert(/^[0-9a-f]{64}$/.test(auth[field]), `${field} missing`);
  });

  await check("sandbox publication uses independent production schemas and intent->proof->head->selection DAG", async () => {
    const fixture = makeFixture("publish"); const protectedBefore = snapshot([fixture.protectedPath, fixture.configPath, path.join(fixture.home, "l1")]);
    const result = await core.executeD3PubSandboxPublication(executeOptions(fixture));
    assert(result.status === "published" && result.generation === 0 && result.selection_seq === 0);
    const closure = core.readPublishedD3PubSelection(fixture.target);
    assert(closure.proof.schema_version === core.D3_PUB_PROOF_SCHEMA);
    assert(core.validateD3PubIntent(closure.intent).intent_hash === result.intent_hash);
    const tamperedIntent = { ...closure.intent, plan_hash: "f".repeat(64) };
    await blocked(() => core.validateD3PubIntent(tamperedIntent), ["D3_PUB_INTENT_INVALID"]);
    assert(closure.head.schema_version === core.D3_PUB_HEAD_SCHEMA);
    assert(closure.selection.schema_version === core.D3_PUB_SELECTION_SCHEMA);
    assert(closure.proof.predicted_head_preimage_hash === closure.head.head_hash);
    assert(closure.head.proof_hash === closure.proof.proof_hash && closure.selection.proof_hash === closure.proof.proof_hash);
    const inventoryRows = closure.proof.mutation_inventory.rows;
    for (const family of ["p2a", "stable"]) {
      const bundle = productionPreview.plan.artifacts[family];
      const bundleDirectory = path.join(fixture.target, family, "v1/bundles", bundle.bundle_hash);
      assert(inventoryRows.some((row) => row.absolute_path === bundleDirectory && row.operation === "mkdir_no_replace"), `missing exact mkdir row for ${family} hash directory`);
    }
    const proofPath = path.join(fixture.target, "proofs/v1", `${result.intent_hash}.json`);
    const proofRow = inventoryRows.find((row) => row.absolute_path === proofPath);
    assert(proofRow?.operation === "immutable_intent_keyed_create_no_replace");
    assert(closure.proof.mutation_inventory.proof_storage_semantics.includes("not a content-addressed CAS"));
    assert(fs.existsSync(path.join(fixture.target, "heads/current.json")) && fs.existsSync(path.join(fixture.target, "selections/current.json")));
    assert(!fs.existsSync(path.join(fixture.target, "current.json")));
    for (const family of ["p2a", "stable"]) for (const name of ["latest", "current", "fallback"]) assert(!fs.existsSync(path.join(fixture.target, family, name)));
    assert(canonicalizeJcs(protectedBefore) === canonicalizeJcs(snapshot([fixture.protectedPath, fixture.configPath, path.join(fixture.home, "l1")])));
    const identical = await core.executeD3PubSandboxPublication(executeOptions(fixture));
    assert(identical.status === "identical" && identical.selection_hash === result.selection_hash);
  });

  for (const crashAfter of ["after_intent", "after_artifacts", "after_proof", "after_head", "after_head_pointer", "after_selection"]) {
    await check(`${crashAfter} recovers only the exact same intent and converges`, async () => {
      const fixture = makeFixture(`crash-${crashAfter}`);
      const error = await blocked(() => core.executeD3PubSandboxPublication(executeOptions(fixture, { crashAfter })), ["D3_PUB_INJECTED_CRASH"]);
      assert(error.detail.point === crashAfter && !fs.existsSync(path.join(fixture.target, "selections/current.json")));
      const recovered = await core.executeD3PubSandboxPublication(executeOptions(fixture));
      assert(recovered.status === "published");
      const closure = core.readPublishedD3PubSelection(fixture.target);
      assert(closure.selection.intent_hash === recovered.intent_hash);
    });
  }

  await check("different-intent and foreign/truncated residue block without overwrite", async () => {
    const foreign = makeFixture("foreign-residue");
    let crash;
    try { await core.executeD3PubSandboxPublication(executeOptions(foreign, { crashAfter: "after_intent" })); } catch (error) { crash = error; }
    assert(crash?.code === "D3_PUB_INJECTED_CRASH");
    fs.writeFileSync(path.join(foreign.target, "intents/v1", `${"f".repeat(64)}.json`), "{}\n", { mode: 0o600 });
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(foreign)), ["D3_PUB_FOREIGN_RESIDUE"]);
    assert(fs.readFileSync(path.join(foreign.target, "intents/v1", `${"f".repeat(64)}.json`), "utf8") === "{}\n");

    const truncated = makeFixture("truncated-residue");
    try { await core.executeD3PubSandboxPublication(executeOptions(truncated, { crashAfter: "after_artifacts" })); } catch {}
    const intent = fs.readdirSync(path.join(truncated.target, "intents/v1")).find((name) => name.endsWith(".json"));
    fs.writeFileSync(path.join(truncated.target, "intents/v1", intent), "{}\n", { mode: 0o600 });
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(truncated)), ["D3_PUB_FOREIGN_RESIDUE", "D3_PUB_CAS_COLLISION"]);
  });

  await check("post-intent protected drift requires fresh dossier/auth and supersedes monotonically at gen0 without head", async () => {
    let fixture = makeFixture("supersede-no-head");
    const error = await blocked(() => core.executeD3PubSandboxPublication(executeOptions(fixture, { hooks: { afterIntent() { fs.writeFileSync(path.join(fixture.protectedPath, "sentinel"), "drifted\n"); } } })), ["D3_PUB_PROTECTED_DRIFT"]);
    assert(error.code === "D3_PUB_PROTECTED_DRIFT" && !fs.existsSync(path.join(fixture.target, "heads/current.json")));
    const oldIntents = fs.readdirSync(path.join(fixture.target, "intents/v1")).filter((name) => name.endsWith(".json"));
    fixture = freshPlan(fixture, "supersede-no-head-fresh");
    assert(fixture.plan.generation === 0 && fixture.plan.predecessor_head_hash === null && fixture.plan.selection_seq === 0);
    const result = await core.executeD3PubSandboxPublication(executeOptions(fixture));
    assert(result.status === "published" && result.generation === 0);
    for (const name of oldIntents) assert(fs.existsSync(path.join(fixture.target, "intents/v1", name)), "old intent was deleted");
  });

  await check("existing unselected head is superseded by fresh dossier/auth at generation+1 while first selection remains seq0", async () => {
    let fixture = makeFixture("supersede-head");
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(fixture, { crashAfter: "after_head_pointer" })), ["D3_PUB_INJECTED_CRASH"]);
    const oldHeadPointer = JSON.parse(fs.readFileSync(path.join(fixture.target, "heads/current.json"), "utf8"));
    fixture = freshPlan(fixture, "supersede-head-fresh");
    assert(fixture.plan.generation === 1 && fixture.plan.predecessor_head_hash === oldHeadPointer.head_hash && fixture.plan.selection_seq === 0);
    const result = await core.executeD3PubSandboxPublication(executeOptions(fixture));
    assert(result.status === "published" && result.generation === 1 && result.selection_seq === 0);
    const closure = core.readPublishedD3PubSelection(fixture.target);
    assert(closure.head.predecessor_head_hash === oldHeadPointer.head_hash && closure.selection.predecessor_selection_hash === null);
  });

  await check("selection presence forbids fresh-plan supersession through this gate", async () => {
    let fixture = makeFixture("selection-block"); await core.executeD3PubSandboxPublication(executeOptions(fixture));
    fixture = freshPlan(fixture, "selection-block-fresh");
    assert(fixture.plan.execution_status === "blocked_selection_exists");
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(fixture)), ["D3_PUB_SELECTION_EXISTS_SUPERSESSION_FORBIDDEN"]);
  });

  await check("parent and child retained OFD locks are nonblocking, ordered, and create no lock files", async () => {
    const parentBusy = makeFixture("parent-busy"); const parentLock = lockModule.acquireRetainedDirectoryOfdLock(parentBusy.sediment); assert(parentLock.status === "ACQUIRED");
    try { const before = snapshot([parentBusy.target]); const result = await core.executeD3PubSandboxPublication(executeOptions(parentBusy)); assert(result.status === "BUSY"); assert(canonicalizeJcs(before) === canonicalizeJcs(snapshot([parentBusy.target]))); }
    finally { parentLock.close(); }

    const childBusy = makeFixture("child-busy");
    try { await core.executeD3PubSandboxPublication(executeOptions(childBusy, { crashAfter: "after_intent" })); } catch {}
    const childLock = lockModule.acquireRetainedDirectoryOfdLock(childBusy.target); assert(childLock.status === "ACQUIRED");
    try { const result = await core.executeD3PubSandboxPublication(executeOptions(childBusy)); assert(result.status === "BUSY"); }
    finally { childLock.close(); }
    for (const directory of [parentBusy.sediment, childBusy.target]) assert(!fs.readdirSync(directory).some((name) => /lock|pid|lease/i.test(name)));
  });

  await check("v1 root and forbidden root/artifact pointers fail closed", async () => {
    const v1 = makeFixture("foreign-v1"); fs.mkdirSync(path.join(v1.sediment, "proposition-lifecycle-freshness/v1"), { recursive: true });
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(v1)), ["D3_PUB_FOREIGN_V1"]);
    const pointer = makeFixture("foreign-pointer");
    try { await core.executeD3PubSandboxPublication(executeOptions(pointer, { crashAfter: "after_intent" })); } catch {}
    fs.writeFileSync(path.join(pointer.target, "current.json"), "{}\n", { mode: 0o600 });
    await blocked(() => core.executeD3PubSandboxPublication(executeOptions(pointer)), ["D3_PUB_FOREIGN_RESIDUE", "D3_PUB_ROOT_CURRENT_FORBIDDEN"]);
  });

  await check("recorded durable authorization survives append-only transcript suffix but explicit revocation blocks", async () => {
    const fixture = makeFixture("recorded-auth");
    const suffixAssistant = { type: "message", id: "later-assistant", parentId: "grant-user", timestamp: "2030-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "recovery progress" }] } };
    const extended = `${fixture.transcriptRaw}${JSON.stringify(suffixAssistant)}\n`;
    const recorded = transcript.verifySyntheticD3PubRatification({ transcriptRaw: extended, dossier: fixture.dossier, recorded: fixture.authorization });
    assert(recorded.coordinate_hash === fixture.authorization.coordinate_hash);
    const revoked = `${extended}${JSON.stringify({ type: "message", id: "later-revoke", parentId: "later-assistant", timestamp: "2030-01-01T00:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "停止当前恢复。" }] } })}\n`;
    await blocked(() => transcript.verifySyntheticD3PubRatification({ transcriptRaw: revoked, dossier: fixture.dossier, recorded: fixture.authorization }), ["D3_PUB_AUTHORIZATION_REVOKED"]);
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`\nADR0040 D3-PUB smoke failed: ${failures.length} failure(s), ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nADR0040 D3-PUB smoke passed: ${passed} checks\n`);
  process.stdout.write(`${JSON.stringify({ passed, real_preview: { dossier_hash: productionPreview.dossier.dossier_hash, plan_hash: productionPreview.plan.plan_hash, capsule_hash: capsule.capsule_hash, commit_oid: capsule.commit_oid, counts: productionPreview.plan.artifacts.counts, production_unchanged: canonicalizeJcs(productionPreview.productionBefore) === canonicalizeJcs(productionPreview.productionAfter) } }, null, 2)}\n`);
}
