#!/usr/bin/env node
/** ADR0040 P2a.2.1 publication contract smoke. All mutation stays in temp sandboxes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(sourceRepoRoot, { interopDefault: true });
const shadow = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-shadow.ts"));
const publication = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));
const evidence = jiti(path.join(sourceRepoRoot, "extensions/_shared/proposition-policy-push-publication-evidence.ts"));
const jcs = jiti(path.join(sourceRepoRoot, "extensions/_shared/jcs.ts"));

const registryPath = path.join(sourceRepoRoot, "schemas/l1-schema-role-registry.json");
const ARTIFACT_NAMES = ["diagnostics.json", "entries.json", "exclusions.json", "manifest.json"];
const CRASH_TRANSITIONS = ["ancestor_partial", "staging_partial", "bundle_ready", "complete_latest"];
const REAL_POLICY_SOURCE_EVENT_ID = "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6";
const P1B_SOURCE_EVENT_ID = "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585";
let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}${err?.detail ? `\n        detail=${JSON.stringify(err.detail)}` : ""}`);
  }
}

async function expectCode(code, fn) {
  let caught;
  try { await fn(); } catch (err) { caught = err; }
  assert(caught, `expected ${code}, operation succeeded`);
  assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}

async function expectFailure(fn) {
  let caught;
  try { await fn(); } catch (err) { caught = err; }
  assert(caught, "expected failure, operation succeeded");
  return caught;
}

function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-p2a21-${label}-`));
  const home = path.join(root, "abrain");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repoRoot);
  return { root, home, repoRoot, intent: path.join(root, "intent.json") };
}

function cleanup(...sandboxes) {
  for (const sandbox of sandboxes) fs.rmSync(sandbox.root, { recursive: true, force: true });
}

async function bindIntent(sandbox, bundle, options = {}) {
  const intent = await publication.__TEST.buildSyntheticIntentFixture({
    abrainHome: sandbox.home,
    repoRoot: sandbox.repoRoot,
    bundle,
    ...options,
  });
  const status = await publication.writePublicationIntent(sandbox.intent, intent);
  assert(status === "created" || status === "identical", `intent status=${status}`);
  return intent;
}

function publish(sandbox, bundle, extra = {}) {
  return publication.__TEST.publishSandboxFixture({
    abrainHome: sandbox.home,
    repoRoot: sandbox.repoRoot,
    bundle,
    intentPath: sandbox.intent,
    ...extra,
  });
}

function targetRoot(home) {
  return path.join(home, ...publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function publicationParent(home) {
  return path.dirname(targetRoot(home));
}

function reviewPaths(sandbox, bundle) {
  return evidence.publicationReviewRelativePaths(bundle.manifest.bundle_hash).map((relative) => path.join(sandbox.repoRoot, ...relative.split("/")));
}

function planPath(sandbox, bundle) {
  return path.join(sandbox.repoRoot, ...evidence.publicationPlannedDiffRelative(bundle.manifest.bundle_hash).split("/"));
}

function writeCanonical(file, value) {
  fs.writeFileSync(file, `${jcs.canonicalizeJcs(value)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertProductionSnapshotUnchanged(before, after, label) {
  if (before.summary.snapshot_hash === after.summary.snapshot_hash) return;
  const transientGitPaths = new Set([".git/index", ".git/index.lock"]);
  const stableRows = (snapshot) => snapshot.rows.filter((row) => !transientGitPaths.has(row.relative_name));
  assert(jcs.canonicalizeJcs(stableRows(before)) === jcs.canonicalizeJcs(stableRows(after)), `${label}; drift exceeds transient .git index metadata`);
}

function rewriteIntent(sandbox, mutate) {
  const intent = readJson(sandbox.intent);
  mutate(intent);
  const review = intent.publication_evidence?.review_record;
  if (review) {
    const reviewBase = { ...review };
    delete reviewBase.review_record_sha256;
    review.review_record_sha256 = jcs.jcsSha256Hex(reviewBase);
  }
  const base = { ...intent };
  delete base.intent_hash;
  intent.intent_hash = jcs.jcsSha256Hex(base);
  writeCanonical(sandbox.intent, intent);
}

function writeExactBundleDirectory(directory, bundle, names = ARTIFACT_NAMES) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(directory, name), bundle.bytes[name], { encoding: "utf8", flag: "wx" });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rehashManifestOnly(bundle) {
  const base = { ...bundle.manifest };
  delete base.bundle_hash;
  bundle.manifest.bundle_hash = jcs.jcsSha256Hex(base);
  bundle.bytes["manifest.json"] = `${jcs.canonicalizeJcs(bundle.manifest)}\n`;
  return bundle;
}

function lockResidueUnder(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const walk = (entry) => {
    const stat = fs.lstatSync(entry);
    if (path.basename(entry).toLowerCase().includes("lock")) found.push(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
  };
  walk(root);
  return found;
}

const crashWorker = String.raw`
import path from "node:path";
import { createRequire } from "node:module";
const [home, sandboxRepo, intent, sourceRepo, registry, transition] = process.argv.slice(1);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(sourceRepo, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(sourceRepo, { interopDefault: true });
const shadow = jiti(path.join(sourceRepo, "extensions/_shared/proposition-policy-push-shadow.ts"));
const publication = jiti(path.join(sourceRepo, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));
const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME, repoRoot: sourceRepo, registryPath: registry });
await publication.__TEST.publishSandboxFixture({ abrainHome: home, repoRoot: sandboxRepo, bundle, intentPath: intent, testCrashAt: transition });
process.exit(91);
`;

const recoveryWorker = String.raw`
import path from "node:path";
import { createRequire } from "node:module";
const [home, sandboxRepo, intent, sourceRepo, registry] = process.argv.slice(1);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(sourceRepo, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(sourceRepo, { interopDefault: true });
const shadow = jiti(path.join(sourceRepo, "extensions/_shared/proposition-policy-push-shadow.ts"));
const publication = jiti(path.join(sourceRepo, "extensions/_shared/proposition-policy-push-shadow-publication.ts"));
const bundle = await shadow.buildPropositionPolicyPushShadow({ abrainHome: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME, repoRoot: sourceRepo, registryPath: registry });
const result = await publication.__TEST.publishSandboxFixture({ abrainHome: home, repoRoot: sandboxRepo, bundle, intentPath: intent });
process.stdout.write(JSON.stringify({ status: result.status, initial_state: result.initial_state, final_state: result.final_state }));
`;

console.log("ADR0040 P2a.2.1 publication contract smoke");

const productionBefore = await publication.capturePublicationWholeSnapshot(publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME);
const tempLocksBefore = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-astack-policy-push-publication-") && name.endsWith(".lock"));
const bundle = await shadow.buildPropositionPolicyPushShadow({
  abrainHome: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME,
  repoRoot: sourceRepoRoot,
  registryPath,
});
shadow.validatePropositionPolicyPushBundle(bundle);
assert(bundle.manifest.schema_version === "proposition-policy-push-shadow-manifest/v2", "semantic manifest is not v2");
assert(bundle.manifest.result.entry_count === 1 && bundle.manifest.result.exclusion_count === 1 && bundle.manifest.result.diagnostic_count === 1, "production bundle is not exact 1/1/1");
assert(JSON.stringify(bundle.entries.entries.map((entry) => entry.source_event_id)) === JSON.stringify([REAL_POLICY_SOURCE_EVENT_ID]), "production entry source is not the real-policy event");
assert(JSON.stringify(bundle.exclusions.exclusions.map((entry) => entry.source_event_id)) === JSON.stringify([P1B_SOURCE_EVENT_ID]), "production exclusion source is not the P1b event");
assert(JSON.stringify(bundle.diagnostics.diagnostics.map((entry) => entry.source_event_id)) === JSON.stringify([P1B_SOURCE_EVENT_ID]), "production diagnostic source is not the P1b event");

await check("publisher is default-denied and production crash hooks are not exposed", async () => {
  await expectCode("NOT_AUTHORIZED", () => publication.publishPropositionPolicyPushShadow({
    abrainHome: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME,
    repoRoot: sourceRepoRoot,
    bundle,
    testCrashAt: "staging_partial",
  }));
  const deniedAfter = await publication.capturePublicationWholeSnapshot(publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME);
  assertProductionSnapshotUnchanged(productionBefore, deniedAfter, "default-denied call changed the existing production publication snapshot");
});

await check("planned diff is deterministic, content-bound, and uses six exact evidence paths", async () => {
  const sandbox = makeSandbox("plan");
  try {
    const intent = await bindIntent(sandbox, bundle);
    const plan = readJson(planPath(sandbox, bundle));
    const snapshot = await publication.capturePublicationWholeSnapshot(sandbox.home);
    const rebuilt = evidence.buildPlannedPublicationDiff({ abrainHome: sandbox.home, targetRelativeName: publication.PROPOSITION_POLICY_PUSH_PUBLICATION_ROOT_RELATIVE, bundle, snapshot });
    assert(jcs.canonicalizeJcs(plan) === jcs.canonicalizeJcs(rebuilt), "planned diff is not deterministic from the exact absent prestate");
    assert(intent.publication_evidence.review_record.signs.length === 6, "review record does not bind six files");
    assert(intent.publication_evidence.review_record.signs.every((sign, index) => sign.relative_path === evidence.publicationReviewRelativePaths(bundle.manifest.bundle_hash)[index]), "review paths are not exact fixed-order repo paths");
    assert(intent.publication_evidence.review_record.artifact_nature.includes("not_cryptographic_vendor_provenance"), "review record overclaims vendor provenance");
  } finally { cleanup(sandbox); }
});

await check("deployment-neutral manifest rejects placement and path fields", async () => {
  for (const [key, value] of [["published_to_abrain", false], ["target_path", "/tmp/escape"], ["publication_placement", "abrain"]]) {
    const altered = clone(bundle);
    altered.manifest[key] = value;
    rehashManifestOnly(altered);
    await expectCode("PROPOSITION_POLICY_PUSH_DEPLOYMENT_FIELD", () => shadow.validatePropositionPolicyPushBundle(altered));
  }
});

await check("absent publication and identical rerun converge without lock or staging residue", async () => {
  const sandbox = makeSandbox("absent");
  try {
    const intent = await bindIntent(sandbox, bundle);
    const first = await publish(sandbox, bundle);
    const second = await publish(sandbox, bundle);
    assert(first.status === "created" && second.status === "identical", `statuses=${first.status}/${second.status}`);
    assert(first.intent_hash === intent.intent_hash && first.final_state === "complete", "intent/final state mismatch");
    assert(fs.readlinkSync(path.join(targetRoot(sandbox.home), "latest")) === `bundles/${bundle.manifest.bundle_hash}`, "latest is not exact relative symlink");
    assert(!fs.existsSync(path.join(targetRoot(sandbox.home), "staging")), "staging residue remains");
    assert(lockResidueUnder(sandbox.root).length === 0, "lock residue exists");
    assert(second.mutation_proof.exact_diff.created.length === 0 && second.mutation_proof.exact_diff.modified.length === 0 && second.mutation_proof.exact_diff.removed.length === 0, "identical rerun mutated filesystem");
  } finally { cleanup(sandbox); }
});

await check("nonexistent, fabricated, tampered, reordered, duplicate, and stale reviews all fail before target mutation", async () => {
  const cases = [];
  for (const label of ["missing", "fabricated", "tampered", "reordered", "duplicate", "stale-review", "stale-plan"]) cases.push(makeSandbox(label));
  try {
    for (const sandbox of cases) await bindIntent(sandbox, bundle);
    fs.unlinkSync(reviewPaths(cases[0], bundle)[0]);

    const fabricatedFile = reviewPaths(cases[1], bundle)[0];
    const fabricated = readJson(fabricatedFile);
    fabricated.vendor = "Fabricated";
    writeCanonical(fabricatedFile, fabricated);
    rewriteIntent(cases[1], (intent) => { intent.publication_evidence.review_record.signs[0].raw_sha256 = jcs.sha256Hex(fs.readFileSync(fabricatedFile)); });

    fs.appendFileSync(reviewPaths(cases[2], bundle)[1], "tamper", "utf8");
    rewriteIntent(cases[3], (intent) => { [intent.publication_evidence.review_record.signs[0], intent.publication_evidence.review_record.signs[1]] = [intent.publication_evidence.review_record.signs[1], intent.publication_evidence.review_record.signs[0]]; });
    rewriteIntent(cases[4], (intent) => { intent.publication_evidence.review_record.signs[1] = clone(intent.publication_evidence.review_record.signs[0]); });
    rewriteIntent(cases[5], (intent) => {
      intent.publication_evidence.review_record.planned_diff_sha256 = "0".repeat(64);
      for (const sign of intent.publication_evidence.review_record.signs) sign.planned_diff_sha256 = "0".repeat(64);
    });
    fs.writeFileSync(path.join(cases[6].home, "protected-drift.txt"), "drift\n", "utf8");

    for (const sandbox of cases) {
      await expectCode("NOT_AUTHORIZED", () => publish(sandbox, bundle));
      assert(!fs.existsSync(targetRoot(sandbox.home)), `${path.basename(sandbox.root)} mutated target`);
    }
  } finally { cleanup(...cases); }
});

await check("missing, malformed, noncanonical, and foreign intents fail before target mutation", async () => {
  const missing = makeSandbox("intent-missing");
  const malformed = makeSandbox("intent-malformed");
  const noncanonical = makeSandbox("intent-noncanonical");
  const foreign = makeSandbox("intent-foreign");
  const other = makeSandbox("intent-other-home");
  try {
    await expectCode("NOT_AUTHORIZED", () => publish(missing, bundle));
    fs.writeFileSync(malformed.intent, "{not-json}\n", "utf8");
    await expectCode("NOT_AUTHORIZED", () => publish(malformed, bundle));
    const normalIntent = await publication.__TEST.buildSyntheticIntentFixture({ abrainHome: noncanonical.home, repoRoot: noncanonical.repoRoot, bundle });
    fs.writeFileSync(noncanonical.intent, `${JSON.stringify(normalIntent, null, 2)}\n`, "utf8");
    await expectCode("NOT_AUTHORIZED", () => publish(noncanonical, bundle));
    await bindIntent(foreign, bundle, { foreignAbrainHome: other.home });
    await expectCode("NOT_AUTHORIZED", () => publish(foreign, bundle));
    for (const sandbox of [missing, malformed, noncanonical, foreign]) assert(!fs.existsSync(targetRoot(sandbox.home)), `${path.basename(sandbox.root)} target was mutated`);
  } finally { cleanup(missing, malformed, noncanonical, foreign, other); }
});

await check("bundle collisions, foreign staging, path escapes, and unsafe symlinks fail closed", async () => {
  const collision = makeSandbox("collision");
  const foreign = makeSandbox("foreign-stage");
  const ancestor = makeSandbox("unsafe-ancestor");
  const latest = makeSandbox("unsafe-latest");
  const escaped = makeSandbox("escape");
  try {
    await bindIntent(collision, bundle);
    const bundleDir = path.join(targetRoot(collision.home), "bundles", bundle.manifest.bundle_hash);
    writeExactBundleDirectory(bundleDir, bundle);
    fs.writeFileSync(path.join(bundleDir, "manifest.json"), "{}\n", "utf8");
    await expectFailure(() => publish(collision, bundle));
    assert(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8") === "{}\n", "collision bytes were replaced");

    await bindIntent(foreign, bundle);
    fs.mkdirSync(path.join(targetRoot(foreign.home), "staging", "foreign"), { recursive: true });
    await expectFailure(() => publish(foreign, bundle));

    await bindIntent(ancestor, bundle);
    const outside = path.join(ancestor.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ancestor.home, ".state"), "dir");
    await expectFailure(() => publish(ancestor, bundle));
    assert(fs.readdirSync(outside).length === 0, "ancestor symlink target was mutated");

    await bindIntent(latest, bundle);
    writeExactBundleDirectory(path.join(targetRoot(latest.home), "bundles", bundle.manifest.bundle_hash), bundle);
    fs.symlinkSync("../../escape", path.join(targetRoot(latest.home), "latest"), "dir");
    await expectFailure(() => publish(latest, bundle));

    await bindIntent(escaped, bundle);
    await expectCode("PROPOSITION_POLICY_PUSH_PATH_ESCAPE", () => publish(escaped, bundle, { targetRootOverrideForTest: path.join(escaped.root, "outside") }));
  } finally { cleanup(collision, foreign, ancestor, latest, escaped); }
});

await check("ancestor-only partial state accepts only the exact evidence-bound planned creation", async () => {
  const exact = makeSandbox("recover-ancestor-exact");
  const foreignPath = makeSandbox("recover-ancestor-foreign-path");
  const foreignContent = makeSandbox("recover-ancestor-foreign-content");
  const foreignSymlink = makeSandbox("recover-ancestor-foreign-symlink");
  try {
    await bindIntent(exact, bundle);
    fs.mkdirSync(publicationParent(exact.home), { recursive: true });
    const recovered = await publish(exact, bundle);
    assert(recovered.status === "created" && recovered.initial_state === "absent" && recovered.final_state === "complete", `ancestor recovery=${JSON.stringify(recovered)}`);

    await bindIntent(foreignPath, bundle);
    fs.mkdirSync(path.join(foreignPath.home, ".state", "sediment"), { recursive: true });
    fs.writeFileSync(path.join(foreignPath.home, ".state", "sediment", "foreign"), "foreign\n", "utf8");
    await expectCode("NOT_AUTHORIZED", () => publish(foreignPath, bundle));

    await bindIntent(foreignContent, bundle);
    fs.mkdirSync(publicationParent(foreignContent.home), { recursive: true });
    fs.writeFileSync(path.join(publicationParent(foreignContent.home), "foreign"), "foreign\n", "utf8");
    await expectCode("NOT_AUTHORIZED", () => publish(foreignContent, bundle));

    await bindIntent(foreignSymlink, bundle);
    fs.mkdirSync(path.dirname(publicationParent(foreignSymlink.home)), { recursive: true });
    const outside = path.join(foreignSymlink.root, "outside-parent");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, publicationParent(foreignSymlink.home), "dir");
    await expectFailure(() => publish(foreignSymlink, bundle));
    assert(fs.readdirSync(outside).length === 0, "foreign ancestor symlink target was mutated");

    for (const sandbox of [foreignPath, foreignContent, foreignSymlink]) {
      assert(!fs.existsSync(targetRoot(sandbox.home)), `${path.basename(sandbox.root)} created v1 after rejection`);
    }
  } finally { cleanup(exact, foreignPath, foreignContent, foreignSymlink); }
});

await check("bundle-ready and exact staging-partial states recover under the bound intent", async () => {
  const bundleReady = makeSandbox("recover-bundle");
  const stagePartial = makeSandbox("recover-stage");
  try {
    await bindIntent(bundleReady, bundle);
    writeExactBundleDirectory(path.join(targetRoot(bundleReady.home), "bundles", bundle.manifest.bundle_hash), bundle);
    const recoveredBundle = await publish(bundleReady, bundle);
    assert(recoveredBundle.status === "recovered" && recoveredBundle.initial_state === "bundle_ready", `bundle recovery=${JSON.stringify(recoveredBundle)}`);

    const intent = await bindIntent(stagePartial, bundle);
    const stageDir = path.join(targetRoot(stagePartial.home), "staging", intent.intent_hash);
    writeExactBundleDirectory(stageDir, bundle, ["entries.json"]);
    const recoveredStage = await publish(stagePartial, bundle);
    assert(recoveredStage.status === "recovered" && recoveredStage.initial_state === "staging_partial", `stage recovery=${JSON.stringify(recoveredStage)}`);
    assert(!fs.existsSync(path.join(targetRoot(stagePartial.home), "staging")), "recovered staging residue remains");
  } finally { cleanup(bundleReady, stagePartial); }
});

await check("concurrent identical publishers converge to one byte-identical lock-free publication", async () => {
  const sandbox = makeSandbox("concurrent");
  try {
    await bindIntent(sandbox, bundle);
    const results = await Promise.all([publish(sandbox, bundle), publish(sandbox, bundle), publish(sandbox, bundle)]);
    assert(results.every((result) => result.final_state === "complete"), `concurrent states=${JSON.stringify(results.map((result) => result.final_state))}`);
    const readback = await publication.__TEST.readSandboxFixture(sandbox.home);
    for (const name of ARTIFACT_NAMES) assert(readback.bytes[name] === bundle.bytes[name], `${name} concurrent readback differs`);
    assert(!fs.existsSync(path.join(targetRoot(sandbox.home), "staging")), "concurrent staging residue remains");
    assert(lockResidueUnder(sandbox.root).length === 0, "concurrent lock residue exists");
  } finally { cleanup(sandbox); }
});

await check("fresh subprocess recovers after SIGKILL at every durable transition with no lock residue", async () => {
  for (const transition of CRASH_TRANSITIONS) {
    const sandbox = makeSandbox(`crash-${transition}`);
    try {
      await bindIntent(sandbox, bundle);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", crashWorker, sandbox.home, sandbox.repoRoot, sandbox.intent, sourceRepoRoot, registryPath, transition], { encoding: "utf8" });
      assert(child.signal === "SIGKILL", `${transition} child did not SIGKILL: status=${child.status} signal=${child.signal} stderr=${child.stderr}`);
      if (transition === "ancestor_partial") {
        assert(fs.lstatSync(publicationParent(sandbox.home)).isDirectory(), "ancestor_partial did not durably create the publication parent");
        assert(fs.readdirSync(publicationParent(sandbox.home)).length === 0, "ancestor_partial parent is not exact and empty");
        assert(!fs.existsSync(targetRoot(sandbox.home)), "ancestor_partial created v1 before SIGKILL");
      }
      const recovery = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryWorker, sandbox.home, sandbox.repoRoot, sandbox.intent, sourceRepoRoot, registryPath], { encoding: "utf8" });
      assert(recovery.status === 0 && recovery.signal === null, `${transition} fresh recovery process failed: status=${recovery.status} signal=${recovery.signal} stderr=${recovery.stderr}`);
      const recovered = JSON.parse(recovery.stdout);
      assert(recovered.final_state === "complete", `${transition} fresh process did not recover: ${recovery.stdout}`);
      assert(!fs.existsSync(path.join(targetRoot(sandbox.home), "staging")), `${transition} left staging residue`);
      assert(lockResidueUnder(sandbox.root).length === 0, `${transition} left lock residue`);
      const readback = await publication.__TEST.readSandboxFixture(sandbox.home);
      assert(readback.manifest.bundle_hash === bundle.manifest.bundle_hash, `${transition} readback differs`);
    } finally { cleanup(sandbox); }
  }
});

await check("published artifact tamper is rejected without replacement", async () => {
  const sandbox = makeSandbox("tamper-final");
  try {
    await bindIntent(sandbox, bundle);
    await publish(sandbox, bundle);
    const artifact = path.join(targetRoot(sandbox.home), "bundles", bundle.manifest.bundle_hash, "exclusions.json");
    fs.writeFileSync(artifact, "{}\n", "utf8");
    await expectFailure(() => publication.__TEST.readSandboxFixture(sandbox.home));
    await expectFailure(() => publish(sandbox, bundle));
    assert(fs.readFileSync(artifact, "utf8") === "{}\n", "tampered artifact was replaced");
  } finally { cleanup(sandbox); }
});

const productionAfter = await publication.capturePublicationWholeSnapshot(publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_ABRAIN_HOME);
const tempLocksAfter = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-astack-policy-push-publication-") && name.endsWith(".lock"));
assertProductionSnapshotUnchanged(productionBefore, productionAfter, "production abrain changed during sandbox smoke");
assert(fs.existsSync(publication.PROPOSITION_POLICY_PUSH_PUBLICATION_HARD_TARGET), "existing production publication target disappeared during sandbox smoke");
assert(JSON.stringify(tempLocksAfter) === JSON.stringify(tempLocksBefore), `anonymous lock residue changed: before=${JSON.stringify(tempLocksBefore)} after=${JSON.stringify(tempLocksAfter)}`);

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; existing production target and all non-transient-git-index abrain rows unchanged, with no lock residue`);
