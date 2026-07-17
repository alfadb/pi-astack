#!/usr/bin/env node
/** ADR0040 P2a.2.2 live publication contract smoke. Mutation is temp-sandbox only. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(sourceRepoRoot, { interopDefault: true });
const api = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-live-publication.ts"));
const planApi = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-live-publication-plan.ts"));
const shadow = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const jcs = jiti(path.join(sourceRepoRoot, "extensions/_shared/jcs.ts"));

let passed = 0;
const failures = [];

function assert(condition, message) { if (!condition) throw new Error(message || "assertion failed"); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack || error}${error?.detail ? `\n        detail=${JSON.stringify(error.detail)}` : ""}`); }
}
async function expectFailure(fn, code = null) {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught, `expected failure${code ? ` ${code}` : ""}`);
  if (code) assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}
function canonical(value) { return `${jcs.canonicalizeJcs(value)}\n`; }
function writeJsonl(file, rows) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8"); }
function appendJsonl(file, row) { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8"); }
function transaction(label) { return crypto.createHash("sha256").update(`p2a22-${label}`).digest("hex"); }

function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-p2a22-${label}-`));
  const home = path.join(root, "abrain");
  fs.mkdirSync(path.join(home, ".state", "sediment"), { recursive: true });
  fs.mkdirSync(path.join(home, ".state", "memory"), { recursive: true });
  fs.mkdirSync(path.join(home, "l1"), { recursive: true });
  fs.writeFileSync(path.join(home, "README.md"), "sandbox\n", "utf8");
  writeJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0]), [{ ts: "2026-07-14T00:00:00.000Z", inject_id: "seed", outcome: "injected", prompt_chars: 1, total_duration_ms: 1 }]);
  writeJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[1]), [{ ts: "2026-07-14T00:00:00.000Z", op: "sync", result: "ok" }]);
  writeJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[2]), [{ schemaVersion: "rule-injector-dualread-audit/v1", observedAtUtc: "2026-07-14T00:00:00.000Z", status: "match", latencyMs: 1 }]);
  execFileSync("git", ["init", "-q", home]);
  execFileSync("git", ["-C", home, "add", "README.md"]);
  execFileSync("git", ["-C", home, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"]);
  return { root, home };
}
function cleanup(...sandboxes) { for (const sandbox of sandboxes) fs.rmSync(sandbox.root, { recursive: true, force: true }); }
function target(home) { return path.join(home, ...planApi.PROPOSITION_POLICY_PUSH_TARGET_RELATIVE.split("/")); }
function appendValidStreams(home, suffix) {
  appendJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0]), { ts: "2026-07-14T00:00:01.000Z", inject_id: `inject-${suffix}`, outcome: "injected", prompt_chars: 2, total_duration_ms: 2, session_id: "session", turn_id: 1 });
  appendJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[1]), { ts: "2026-07-14T00:00:01.000Z", op: "writer_publication", result: "local_durable" });
  appendJsonl(path.join(home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[2]), { schemaVersion: "rule-injector-dualread-audit/v1", observedAtUtc: "2026-07-14T00:00:01.000Z", status: "delta", latencyMs: 2 });
}

function materializeStaticRepo(planValue, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-p2a22-static-${label}-`));
  const runtime = planValue.proposition_anchors.runtime;
  const paths = new Set([
    ...planValue.confinement.source_inventory.rows.map((row) => row.path),
    ...runtime.extension_dependency_graph.files.map((row) => row.path),
    planApi.PROPOSITION_POLICY_PUSH_V1_PLAN_RELATIVE,
    ...planApi.PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE.map((row) => row.relative_path),
  ]);
  for (const relative of paths) {
    const source = path.join(sourceRepoRoot, ...relative.split("/"));
    const destination = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const planFile = path.join(root, ...planApi.PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE.split("/"));
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, canonical(planValue), "utf8");
  return root;
}

console.log("ADR0040 P2a.2.2 live-system publication contract smoke");
const productionTargetBefore = fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET);
const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN, repoRoot: sourceRepoRoot, registryPath: path.join(sourceRepoRoot, "schemas/l1-schema-role-registry.json") });
const plan = await planApi.buildPublicationPlanV2({ repoRoot: sourceRepoRoot, bundle });
const planRawSha256 = jcs.sha256Hex(canonical(plan));

await check("v2 plan binds static anchors and exact inventory but no whole snapshot or HEAD", async () => {
  planApi.validatePublicationPlanV2(plan, { bundle });
  const text = canonical(plan);
  assert(plan.schema_version === "proposition-policy-push-publication-plan/v2", "plan schema differs");
  assert(plan.historical_v1.raw_sha256 === "7cd37d339625be77a11bc2c51a9abcf2a95776d8433f9fdaa1ce83fc9acbbe8f", "v1 raw hash differs");
  assert(plan.drift_registry.rows.map((row) => row.relative_path).join("|") === planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS.join("|"), "drift registry paths differ");
  assert(!text.includes("whole_abrain_snapshot_hash") && !text.includes('"head"'), "forbidden live review binding present");
  assert(plan.exact_final_inventory.some((row) => row.relative_name.endsWith("/latest")), "exact final inventory lacks latest");
  assert(plan.confinement.source_inventory.rows.some((row) => row.path === planApi.PROPOSITION_POLICY_PUSH_PRODUCTION_CLI), "production CLI is absent from source inventory");
  assert(plan.execution_contract.package_commands["publish:proposition-policy-push-shadow"] === "node scripts/publish-proposition-policy-push-shadow.mjs", "production package command differs");
  assert(plan.proposition_anchors.runtime.production_publication_dependency_graph.files.some((row) => row.path === planApi.PROPOSITION_POLICY_PUSH_PRODUCTION_CLI), "production CLI is absent from executable dependency graph");
  assert(plan.proposition_anchors.runtime.publication_modules_runtime_reachable === false && plan.proposition_anchors.runtime.forbidden_publication_reachable_paths.length === 0, "forbidden publication code is runtime reachable");
});

await check("production CLI/package/runtime graph drift invalidates static plan before target mutation", async () => {
  const root = materializeStaticRepo(plan, "drift");
  const sandbox = makeSandbox("static-drift");
  try {
    await planApi.validateCurrentStaticPlanAnchors({ repoRoot: root, bundle, plan });
    const cli = path.join(root, planApi.PROPOSITION_POLICY_PUSH_PRODUCTION_CLI);
    fs.appendFileSync(cli, "\n// tamper\n", "utf8");
    await expectFailure(() => planApi.validateCurrentStaticPlanAnchors({ repoRoot: root, bundle, plan }));
    await expectFailure(() => api.executeProductionPublicationV2({ repoRoot: root, bundle }), "STATIC_ANCHOR_DRIFT");
    assert(!fs.existsSync(target(sandbox.home)) && !fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET), "CLI tamper validation mutated a target");
    fs.copyFileSync(path.join(sourceRepoRoot, planApi.PROPOSITION_POLICY_PUSH_PRODUCTION_CLI), cli);
    const runtimeRoot = plan.proposition_anchors.runtime.extension_dependency_graph.roots[0];
    const runtimeFile = path.join(root, ...runtimeRoot.split("/"));
    fs.appendFileSync(runtimeFile, "\nimport \"../_shared/proposition-policy-push-live-publication\";\n", "utf8");
    await expectFailure(() => planApi.validateCurrentStaticPlanAnchors({ repoRoot: root, bundle, plan }), "PLAN_RUNTIME_REACHABILITY");
    await expectFailure(() => api.executeProductionPublicationV2({ repoRoot: root, bundle }), "PLAN_RUNTIME_REACHABILITY");
    fs.copyFileSync(path.join(sourceRepoRoot, ...runtimeRoot.split("/")), runtimeFile);
    const historical = path.join(root, ...planApi.PROPOSITION_POLICY_PUSH_HISTORICAL_EVIDENCE[0].relative_path.split("/"));
    fs.appendFileSync(historical, "tamper", "utf8");
    await expectFailure(() => api.executeProductionPublicationV2({ repoRoot: root, bundle }), "PLAN_HISTORY_DRIFT");
    assert(!fs.existsSync(target(sandbox.home)) && !fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET), "runtime/history drift validation mutated a target");
  } finally { fs.rmSync(root, { recursive: true, force: true }); cleanup(sandbox); }
});

await check("actual bwrap effectiveness preflight proves read-only host, namespaces, environment, caps, FD closure, and network denial", async () => {
  const sandbox = makeSandbox("effectiveness");
  try {
    const result = await api.__TEST.runBubblewrapEffectivenessPreflight({ repoRoot: sourceRepoRoot, plan, abrainHome: sandbox.home });
    assert(result.effective === true && result.namespace_separation === true, "effectiveness preflight did not pass");
  } finally { cleanup(sandbox); }
});

await check("bwrap unavailable and simulated disabled user namespace fail closed", async () => {
  const sandbox = makeSandbox("effectiveness-failures");
  try {
    await expectFailure(() => api.__TEST.runBubblewrapEffectivenessPreflight({ repoRoot: sourceRepoRoot, plan, abrainHome: sandbox.home, bwrapPathOverrideForTest: "/nonexistent/bwrap" }), "BWRAP_UNAVAILABLE");
    await expectFailure(() => api.__TEST.runBubblewrapEffectivenessPreflight({ repoRoot: sourceRepoRoot, plan, abrainHome: sandbox.home, simulateDisabledUsernsForTest: true }), "CONFINEMENT_PREFLIGHT_FAILED");
  } finally { cleanup(sandbox); }
});

await check("synthetic six-review AND user gates bind exact v2 plan bytes and reject tamper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p2a22-gates-"));
  try {
    const planFile = path.join(root, ...planApi.PROPOSITION_POLICY_PUSH_PLAN_V2_RELATIVE.split("/"));
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, canonical(plan), "utf8");
    const fixtures = api.buildSyntheticGateArtifactsV2({ plan, planRawSha256 });
    const reviewPaths = planApi.publicationReviewV2RelativePaths();
    fixtures.reviews.forEach((review, index) => { const file = path.join(root, ...reviewPaths[index].split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, canonical(review), "utf8"); });
    const intentFile = path.join(root, ...planApi.publicationIntentV3Relative().split("/"));
    fs.writeFileSync(intentFile, canonical(fixtures.intent), "utf8");
    const binding = await api.validatePublicationGatesV2({ repoRoot: root, bundle, mode: "sandbox_test", syntheticAuthorization: true, skipCurrentStaticAnchorsForTest: true });
    assert(binding.reviews.length === 6 && binding.plan_hash === plan.plan_hash, "gate binding differs");
    fs.appendFileSync(path.join(root, ...reviewPaths[0].split("/")), "tamper", "utf8");
    await expectFailure(() => api.validatePublicationGatesV2({ repoRoot: root, bundle, mode: "sandbox_test", syntheticAuthorization: true, skipCurrentStaticAnchorsForTest: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

await check("all exposed sandbox mutation/test APIs reject the production root before work", async () => {
  const common = { repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN, transactionId: transaction("production-root-denial") };
  const entries = [
    ["executeSandboxPublicationFixture", () => api.executeSandboxPublicationFixture(common)],
    ["__TEST.runBubblewrapEffectivenessPreflight", () => api.__TEST.runBubblewrapEffectivenessPreflight(common)],
    ["__TEST.runConfinedBootstrap", () => api.__TEST.runConfinedBootstrap(common)],
    ["__TEST.runConfinedInstaller", () => api.__TEST.runConfinedInstaller(common)],
    ["__TEST.captureDriftCutoffsWithTerminalHook", () => api.__TEST.captureDriftCutoffsWithTerminalHook(planApi.PROPOSITION_POLICY_PUSH_HARD_ABRAIN)],
  ];
  assert(typeof api.runBubblewrapEffectivenessPreflight === "undefined" && typeof api.runConfinedBootstrap === "undefined" && typeof api.runConfinedInstaller === "undefined", "low-level mutators remain exported");
  assert(Object.keys(api.__TEST).sort().join("|") === "captureDriftCutoffsWithTerminalHook|runBubblewrapEffectivenessPreflight|runConfinedBootstrap|runConfinedInstaller", "unexpected test API surface");
  for (const [name, invoke] of entries) {
    await expectFailure(invoke, "SANDBOX_REQUIRED");
    assert(!fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET), `${name} reached the production target`);
  }
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-p2a22-symlink-root-"));
  try {
    const real = path.join(symlinkRoot, "real");
    const linked = path.join(symlinkRoot, "linked");
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked, "dir");
    await expectFailure(() => api.__TEST.captureDriftCutoffsWithTerminalHook(linked), "SANDBOX_REQUIRED");
  } finally { fs.rmSync(symlinkRoot, { recursive: true, force: true }); }
});

await check("confined bootstrap plus installer accepts exact concurrent stream appends and reaches five-way completion", async () => {
  const sandbox = makeSandbox("happy");
  try {
    const result = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction("happy"), afterInstallForTest: () => appendValidStreams(sandbox.home, "happy") });
    assert(result.completion === true, `completion false: ${JSON.stringify(result.verdicts)}`);
    assert(result.drift.every((row) => row.suffix_row_count === 1), "exact appends were not accepted");
    assert(result.drift[1].suffix_rows[0].native_ids && Object.keys(result.drift[1].suffix_rows[0].native_ids).length === 0, "git-sync received an invented native ID");
    assert(fs.readlinkSync(path.join(target(sandbox.home), "latest")) === `bundles/${bundle.manifest.bundle_hash}`, "latest differs");
  } finally { cleanup(sandbox); }
});

await check("bootstrap protection rejects sibling, v2, parent mode, and arbitrary target descendants", async () => {
  const cases = ["sediment-sibling", "v2", "parent-mode", "target-descendant"].map(makeSandbox);
  try {
    for (const [index, sandbox] of cases.entries()) {
      await expectFailure(() => api.executeSandboxPublicationFixture({
        repoRoot: sourceRepoRoot,
        plan,
        planRawSha256,
        bundle,
        abrainHome: sandbox.home,
        transactionId: transaction(`bootstrap-${index}`),
        afterBootstrapForTest: () => {
          const parent = path.dirname(target(sandbox.home));
          if (index === 0) fs.writeFileSync(path.join(sandbox.home, ".state", "sediment", "foreign-sibling"), "x");
          if (index === 1) fs.mkdirSync(path.join(parent, "v2"));
          if (index === 2) fs.chmodSync(parent, 0o755);
          if (index === 3) fs.writeFileSync(path.join(target(sandbox.home), "arbitrary"), "x");
        },
      }), "BOOTSTRAP_POSTCHECK_DRIFT");
    }
  } finally { cleanup(...cases); }
});

await check("installer kernel bind denies sibling, L1, .git, tmp, and caller environment paths", async () => {
  const sandbox = makeSandbox("installer-kernel-denials");
  try {
    const result = await api.__TEST.runBubblewrapEffectivenessPreflight({ repoRoot: sourceRepoRoot, plan, abrainHome: sandbox.home });
    assert(Object.values(result.host_write_denials).every((row) => row.denied === true), "a host write was not denied");
    assert(result.environment_keys.join(",") === "LANG,LC_ALL,PATH,PWD", "caller environment leaked beyond bwrap-generated PWD");
  } finally { cleanup(sandbox); }
});

await check("FD/path/symlink/replacement handoffs fail closed", async () => {
  const sandbox = makeSandbox("handoff");
  try {
    const sediment = path.join(sandbox.home, ".state", "sediment");
    const outside = path.join(sandbox.root, "outside");
    fs.mkdirSync(outside);
    fs.renameSync(sediment, `${sediment}.real`);
    fs.symlinkSync(outside, sediment, "dir");
    await expectFailure(() => api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home }), "FD_HANDOFF_UNSAFE");
    fs.unlinkSync(sediment);
    fs.renameSync(`${sediment}.real`, sediment);
    await api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home });
    await expectFailure(() => api.__TEST.runConfinedInstaller({
      repoRoot: sourceRepoRoot,
      plan,
      planRawSha256,
      bundle,
      abrainHome: sandbox.home,
      transactionId: transaction("replace"),
      afterTargetPinForTest: () => {
        fs.renameSync(target(sandbox.home), `${target(sandbox.home)}.old`);
        fs.mkdirSync(target(sandbox.home));
      },
    }), "FD_HANDOFF_REPLACED");
  } finally { cleanup(sandbox); }
});

await check("verified bwrap, Node, and helper FDs defeat pathname replacement after verification", async () => {
  const specs = [
    { key: "bwrapPath", source: plan.confinement.bubblewrap.path, label: "bwrap" },
    { key: "runtimePath", source: plan.confinement.runtime_executable.path, label: "runtime" },
    { key: "helperPath", source: path.join(sourceRepoRoot, "scripts/proposition-policy-push-bootstrap-helper.mjs"), label: "helper" },
  ];
  for (const spec of specs) {
    const sandbox = makeSandbox(`exec-fd-${spec.label}`);
    const executableRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-p2a22-exec-${spec.label}-`));
    const candidate = path.join(executableRoot, path.basename(spec.source));
    const marker = path.join(target(sandbox.home), `replacement-${spec.label}-executed`);
    try {
      fs.copyFileSync(spec.source, candidate);
      fs.chmodSync(candidate, spec.label === "helper" ? 0o644 : 0o755);
      const overrides = {
        [spec.key]: candidate,
        afterOpen: ({ bwrap, runtime, helper }) => {
          const selected = spec.label === "bwrap" ? bwrap : spec.label === "runtime" ? runtime : helper;
          fs.renameSync(selected, `${selected}.verified`);
          if (spec.label === "helper") fs.writeFileSync(selected, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "bad");\n`, "utf8");
          else fs.writeFileSync(selected, `#!/bin/sh\nprintf bad > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
        },
      };
      await expectFailure(() => api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home, executableOverridesForTest: overrides }), "FD_HANDOFF_REPLACED");
      assert(fs.existsSync(target(sandbox.home)), `${spec.label} verified object was not executed`);
      assert(!fs.existsSync(marker), `${spec.label} replacement pathname bytes executed`);
    } finally { cleanup(sandbox); fs.rmSync(executableRoot, { recursive: true, force: true }); }
  }
});

await check("replacement, truncation, torn, malformed, wrong-schema, and new unregistered drift are rejected", async () => {
  const cases = ["replace", "truncate", "torn", "malformed", "wrong", "unregistered"].map(makeSandbox);
  try {
    for (const [index, sandbox] of cases.entries()) {
      const cutoffs = await api.captureDriftCutoffs(sandbox.home);
      const file = path.join(sandbox.home, planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[index < 5 ? Math.min(index, 2) : 0]);
      if (index === 0) { const replacement = `${file}.new`; fs.writeFileSync(replacement, fs.readFileSync(file)); fs.renameSync(replacement, file); }
      if (index === 1) fs.truncateSync(file, 0);
      if (index === 2) fs.appendFileSync(file, "{\"ts\":", "utf8");
      if (index === 3) fs.appendFileSync(file, "not-json\n", "utf8");
      if (index === 4) appendJsonl(file, { schemaVersion: "wrong/v1", observedAtUtc: "x", status: "match", latencyMs: 1 });
      if (index === 5) {
        const before = await api.captureProtectedState(sandbox.home);
        fs.writeFileSync(path.join(sandbox.home, ".state", "unregistered.jsonl"), "{}\n", "utf8");
        const after = await api.captureProtectedState(sandbox.home);
        assert(before.state_hash !== after.state_hash, "unregistered drift escaped protected equality");
        continue;
      }
      await expectFailure(() => api.verifyDriftSuffixes(cutoffs, { retries: 2, retryDelayMs: 1 }));
    }
  } finally { cleanup(...cases); }
});

await check("terminal registered-stream rename/symlink swap after FD read fails", async () => {
  const sandbox = makeSandbox("stream-terminal-swap");
  let swapped = false;
  try {
    await expectFailure(() => api.__TEST.captureDriftCutoffsWithTerminalHook(sandbox.home, (relative, file) => {
      if (swapped || relative !== planApi.PROPOSITION_POLICY_PUSH_DRIFT_PATHS[0]) return;
      swapped = true;
      fs.renameSync(file, `${file}.opened`);
      fs.symlinkSync(`${file}.opened`, file);
    }), "DRIFT_STREAM_REPLACED");
  } finally { cleanup(sandbox); }
});

await check("protected mutation fails completion while exact target remains inert", async () => {
  const sandbox = makeSandbox("protected-drift");
  try {
    const result = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction("protected"), afterInstallForTest: () => fs.appendFileSync(path.join(sandbox.home, "README.md"), "drift\n") });
    assert(result.completion === false && result.verdicts.protected === false && result.target_inert === true, "protected drift did not produce inert incomplete target");
  } finally { cleanup(sandbox); }
});

await check("post-install v2 sibling, parent mode drift, arbitrary descendant, and staging residue fail protected/target verdicts", async () => {
  const cases = ["v2", "parent-mode", "descendant", "residue"].map(makeSandbox);
  try {
    for (const [index, sandbox] of cases.entries()) {
      const result = await api.executeSandboxPublicationFixture({
        repoRoot: sourceRepoRoot,
        plan,
        planRawSha256,
        bundle,
        abrainHome: sandbox.home,
        transactionId: transaction(`post-${index}`),
        afterInstallForTest: () => {
          const parent = path.dirname(target(sandbox.home));
          if (index === 0) fs.mkdirSync(path.join(parent, "v2"));
          if (index === 1) fs.chmodSync(parent, 0o755);
          if (index === 2) fs.writeFileSync(path.join(target(sandbox.home), "arbitrary"), "x");
          if (index === 3) fs.mkdirSync(path.join(target(sandbox.home), "staging", "residue"), { recursive: true });
        },
      });
      assert(result.completion === false, `${index} post-install mutation completed`);
      if (index < 2) assert(result.verdicts.protected === false, `${index} escaped protected verdict`);
      else assert(result.verdicts.target === false, `${index} escaped target verdict`);
    }
  } finally { cleanup(...cases); }
});

await check("git metadata byte hashing detects same-size rewrite and worktree mutation remains protected", async () => {
  const sandbox = makeSandbox("git-forensic");
  try {
    const protectedBefore = await api.captureProtectedState(sandbox.home);
    const gitBefore = await api.captureGitForensics(sandbox.home);
    const config = path.join(sandbox.home, ".git", "config");
    fs.appendFileSync(config, "\n# aaaa\n", "utf8");
    const gitAaaa = await api.captureGitForensics(sandbox.home);
    const configBytes = fs.readFileSync(config, "utf8");
    fs.writeFileSync(config, configBytes.replace("# aaaa", "# bbbb"), "utf8");
    const protectedMetadata = await api.captureProtectedState(sandbox.home);
    const gitAfter = await api.captureGitForensics(sandbox.home);
    assert(protectedBefore.state_hash === protectedMetadata.state_hash, "git metadata entered protected worktree state");
    assert(gitBefore.metadata_hash !== gitAaaa.metadata_hash, "git metadata append was not recorded");
    assert(gitAaaa.metadata_hash !== gitAfter.metadata_hash, "same-size aaaa to bbbb rewrite escaped byte hashing");
    fs.appendFileSync(path.join(sandbox.home, "README.md"), "worktree drift\n", "utf8");
    const protectedAfter = await api.captureProtectedState(sandbox.home);
    assert(protectedAfter.state_hash !== protectedBefore.state_hash, "worktree mutation escaped protected state");
  } finally { cleanup(sandbox); }
});

await check("SIGKILL at every transition is recoverable by a fresh same-plan confined process", async () => {
  for (const transition of ["parent_ready", "staging_partial", "bundle_ready", "complete_latest"]) {
    const sandbox = makeSandbox(`crash-${transition}`);
    try {
      if (transition === "parent_ready") {
        await expectFailure(() => api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home, testCrashAt: "parent_ready" }), "BOOTSTRAP_CONFINED_FAILED");
      } else {
        await api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home });
        await expectFailure(() => api.__TEST.runConfinedInstaller({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction(`crash-${transition}`), testCrashAt: transition }), "INSTALLER_CONFINED_FAILED");
      }
      const recovered = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction(`crash-${transition}`) });
      assert(recovered.completion === true, `${transition} recovery did not complete`);
    } finally { cleanup(sandbox); }
  }
});

await check("forced stale-ready/latest race freshly verifies a valid concurrent completion", async () => {
  const sandbox = makeSandbox("forced-stale-ready");
  try {
    await api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home });
    const paused = api.__TEST.runConfinedInstaller({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction("forced-stale-ready"), testPauseAfterStaleReadyMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const winner = await api.__TEST.runConfinedInstaller({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction("forced-stale-ready") });
    const resumed = await paused;
    assert(winner.result.final_state === "complete" && resumed.result.final_state === "complete", "forced concurrent completion did not converge");
    assert(resumed.result.stale_ready_rechecks >= 1, "forced stale-ready branch was not observed");
  } finally { cleanup(sandbox); }
});

const stressRepetitions = Number(process.env.P2A22_STRESS_REPETITIONS || 30);
const stressProcesses = Number(process.env.P2A22_STRESS_PROCESSES || 20);
await check(`concurrent same-plan installers converge lock-free (${stressRepetitions} repetitions x ${stressProcesses} processes)`, async () => {
  for (let repetition = 0; repetition < stressRepetitions; repetition += 1) {
    const sandbox = makeSandbox(`concurrent-${repetition}`);
    try {
      await api.__TEST.runConfinedBootstrap({ repoRoot: sourceRepoRoot, plan, planRawSha256, abrainHome: sandbox.home });
      const results = await Promise.all(Array.from({ length: stressProcesses }, () => api.__TEST.runConfinedInstaller({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: sandbox.home, transactionId: transaction(`concurrent-${repetition}`) })));
      assert(results.every((row) => row.result.final_state === "complete"), `concurrent installer did not converge at repetition ${repetition}`);
      const actual = await api.captureExactFinalInventory(sandbox.home);
      assert(canonical(actual) === canonical(plan.exact_final_inventory), `concurrent final inventory differs at repetition ${repetition}`);
      assert(!fs.existsSync(path.join(target(sandbox.home), "staging")), `staging residue remains at repetition ${repetition}`);
    } finally { cleanup(sandbox); }
  }
});

await check("anchor advance prevents retrospective blessing while unchanged same-plan rerun is allowed", async () => {
  const advanced = makeSandbox("advanced");
  const same = makeSandbox("same-plan");
  try {
    const failed = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: advanced.home, transactionId: transaction("advanced"), forceStaticAnchorAdvancedForTest: true });
    assert(failed.completion === false && failed.verdicts.runtime === false && failed.target_inert === true, "anchor advance did not keep target inert");
    const first = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: same.home, transactionId: transaction("same") });
    const second = await api.executeSandboxPublicationFixture({ repoRoot: sourceRepoRoot, plan, planRawSha256, bundle, abrainHome: same.home, transactionId: transaction("same") });
    assert(first.completion === true && second.completion === true && second.installer.result.status === "identical", "same-plan rerun was not allowed");
  } finally { cleanup(advanced, same); }
});

await check("production publisher CLI has no direct unconstrained production mutation route", async () => {
  const source = fs.readFileSync(path.join(sourceRepoRoot, "scripts/publish-proposition-policy-push-shadow.mjs"), "utf8");
  assert(!source.includes("publishPropositionPolicyPushShadow({"), "legacy CLI still directly invokes the production filesystem publisher");
  assert(!fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET), "production target exists during smoke");
});

assert(productionTargetBefore === false && !fs.existsSync(planApi.PROPOSITION_POLICY_PUSH_HARD_TARGET), "production target state changed during sandbox smoke");

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; installer stress=${stressRepetitions} repetitions/${stressRepetitions * stressProcesses} processes; all mutation stayed in temp sandboxes and production target remained absent`);
