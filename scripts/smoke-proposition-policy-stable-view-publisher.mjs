#!/usr/bin/env node
/** ADR0040 generalized stable-view publisher smoke. Every derived write is under disposable temp. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const publisher = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
const stable = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view.ts"));
const contract = jiti(path.join(repoRoot, "extensions/_shared/proposition-policy-stable-view-contract.ts"));
const sourceProduction = "/home/worker/.abrain";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-stable-publisher-"));
const fixtureAbrain = path.join(tmpRoot, "fixture-abrain");
const FIVE = ["diagnostics.json", "manifest.json", "parity.json", "view.json", "view.md"];
const eventIds = [
  "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6",
  "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3",
  "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585",
];
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function expectFailure(fn) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, "expected operation to fail");
  return caught;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  return `${stable.stableViewCanonicalizeJcs(value)}\n`;
}

function rehashPublicationManifest(input, mutate) {
  const attacked = clone(input);
  mutate(attacked.manifest);
  delete attacked.manifest.bundle_hash;
  delete attacked.manifest.manifest_hash;
  const bundleHash = stable.stableViewJcsSha256Hex(attacked.manifest);
  attacked.manifest.bundle_hash = bundleHash;
  attacked.manifest.manifest_hash = bundleHash;
  attacked.bundle_hash = bundleHash;
  attacked.artifacts["manifest.json"] = canonicalJson(attacked.manifest);
  return attacked;
}

function stableRoot(abrain) {
  return path.join(abrain, ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"));
}

function makeTarget(label) {
  const home = path.join(tmpRoot, label);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function writeBundle(directory, bundle, names = FIVE) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(directory, name), bundle.artifacts[name], { mode: 0o600 });
}

function copyFixtureL1() {
  fs.mkdirSync(fixtureAbrain, { recursive: true });
  for (const eventId of eventIds) {
    const relative = path.join("l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
    const target = path.join(fixtureAbrain, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceProduction, relative), target);
  }
}

console.log("ADR0040 generalized stable-view publisher smoke");
copyFixtureL1();
let bundle;

try {
  await asyncCheck("sandbox canonical L1 projects to exact 1/1/1 and deterministic nonempty all-five bundle", async () => {
    const first = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: fixtureAbrain, repoRoot });
    const second = await publisher.buildPropositionPolicyStableViewBundle({ sourceAbrainHome: fixtureAbrain, repoRoot });
    const historicalAlias = await publisher.buildPropositionPolicyStableViewMvpBundle({ sourceAbrainHome: fixtureAbrain, repoRoot });
    bundle = first;
    assert(first.bundle_hash === second.bundle_hash, "bundle hash is nondeterministic");
    assert(first.bundle_hash === historicalAlias.bundle_hash && FIVE.every((name) => first.artifacts[name] === historicalAlias.artifacts[name]), "historical P2b1 API alias differs");
    assert(FIVE.every((name) => first.artifacts[name] === second.artifacts[name]), "artifact bytes are nondeterministic");
    assert(first.source_bundle.manifest.result.entry_count === 1, "candidate count differs");
    assert(first.source_bundle.manifest.result.exclusion_count === 1, "exclusion count differs");
    assert(first.source_bundle.manifest.result.diagnostic_count === 1, "diagnostic count differs");
    const view = JSON.parse(first.artifacts["view.json"]);
    assert(view.items.length === 1 && first.artifacts["view.md"].length > 0, "stable view is not nonempty one-item");
    assert(JSON.stringify(Object.keys(first.artifacts).sort()) === JSON.stringify([...FIVE].sort()), "artifact set is not exact all-five");
    publisher.validatePropositionPolicyStableViewBundle(first);
    publisher.validatePropositionPolicyStableViewMvpBundle(historicalAlias);
  });

  await asyncCheck("preview publisher creates no-replace CAS plus relative latest and identical rerun changes no bundle inode", async () => {
    const target = makeTarget("cas-target");
    const first = await publisher.publishPropositionPolicyStableView({
      mode: "preview", sourceAbrainHome: fixtureAbrain, repoRoot, sandboxAbrainHome: target,
    });
    const before = new Map(FIVE.map((name) => [name, fs.lstatSync(path.join(first.bundle_directory, name)).ino]));
    const second = await publisher.publishPropositionPolicyStableView({
      mode: "preview", sourceAbrainHome: fixtureAbrain, repoRoot, sandboxAbrainHome: target,
    });
    assert(first.status === "created" && second.status === "identical", `statuses ${first.status}/${second.status}`);
    assert(fs.readlinkSync(first.latest_symlink) === `bundles/${first.bundle_hash}`, "latest is not an exact relative symlink");
    assert(FIVE.every((name) => fs.lstatSync(path.join(first.bundle_directory, name)).ino === before.get(name)), "identical rerun replaced a CAS artifact");
    assert(fs.readdirSync(first.bundle_directory).sort().join("\n") === [...FIVE].sort().join("\n"), "CAS bundle is partial or foreign");
  });

  check("compiler output manifest hashes bind the deterministic inner compiler manifest", () => {
    const attacked = rehashPublicationManifest(bundle, (manifest) => {
      manifest.compiler.compiler_output_manifest_hash = "f".repeat(64);
      manifest.compiler.compiler_output_manifest_raw_sha256 = "e".repeat(64);
    });
    const error = expectFailure(() => publisher.validatePropositionPolicyStableViewBundle(attacked));
    assert(error.code === "COMPILER_MANIFEST_BINDING_INVALID", `arbitrary compiler hashes failed as ${error.code || error}`);
  });

  check("publisher hard envelope accepts the readable bundle and rejects artifact limit plus one before materialization", () => {
    const acceptedBytes = FIVE.reduce((sum, name) => sum + Buffer.byteLength(bundle.artifacts[name]), 0);
    assert(acceptedBytes <= contract.PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_SET_UTF8_BYTES, "valid bundle exceeds shared all-five limit");
    assert(FIVE.every((name) => Buffer.byteLength(bundle.artifacts[name]) <= contract.PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES), "valid bundle exceeds shared per-artifact limit");
    const target = makeTarget("reject-limit-plus-one");
    const attacked = clone(bundle);
    attacked.artifacts["view.md"] = "x".repeat(contract.PROPOSITION_POLICY_STABLE_VIEW_MAX_ARTIFACT_UTF8_BYTES + 1);
    const error = expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: target, bundle: attacked }));
    assert(error.code === "PUBLICATION_ARTIFACT_OVERSIZE", `oversize bundle failed as ${error.code || error}`);
    assert(!fs.existsSync(stableRoot(target)), "oversize rejection mutated the target before materialization");
  });

  check("authorized publication semantics refresh latest selection time without replacing identical CAS artifacts", () => {
    const target = makeTarget("selection-refresh-target");
    const first = publisher.__TEST.materializeBundle({ mode: "production", targetAbrainHome: target, bundle });
    const artifactInodes = new Map(FIVE.map((name) => [name, fs.lstatSync(path.join(first.bundle_directory, name)).ino]));
    const firstLatestInode = fs.lstatSync(first.latest_symlink).ino;
    const second = publisher.__TEST.materializeBundle({ mode: "production", targetAbrainHome: target, bundle });
    assert(fs.lstatSync(second.latest_symlink).ino !== firstLatestInode, "identical production publication did not refresh latest symlink identity");
    const changedArtifacts = FIVE.filter((name) => fs.lstatSync(path.join(second.bundle_directory, name)).ino !== artifactInodes.get(name));
    assert(changedArtifacts.length === 0, `selection refresh replaced CAS artifacts: ${changedArtifacts.join(",")}`);
  });

  check("partial and byte-colliding final bundles fail closed without replacement", () => {
    for (const [label, names] of [["partial", ["view.json"]], ["collision", FIVE]]) {
      const target = makeTarget(`reject-${label}`);
      const directory = path.join(stableRoot(target), "bundles", bundle.bundle_hash);
      writeBundle(directory, bundle, names);
      if (label === "collision") fs.writeFileSync(path.join(directory, "view.md"), "foreign\n", "utf8");
      const before = fs.readFileSync(path.join(directory, names[0]), "utf8");
      expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: target, bundle }));
      assert(fs.readFileSync(path.join(directory, names[0]), "utf8") === before, `${label} state was replaced`);
    }
  });

  check("foreign root entries and unsafe ancestor/bundle symlinks fail closed", () => {
    const foreign = makeTarget("reject-foreign");
    fs.mkdirSync(stableRoot(foreign), { recursive: true });
    fs.writeFileSync(path.join(stableRoot(foreign), "foreign"), "foreign\n");
    expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: foreign, bundle }));

    const ancestor = makeTarget("reject-ancestor-symlink");
    const outside = path.join(tmpRoot, "outside-ancestor");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ancestor, ".state"), "dir");
    expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: ancestor, bundle }));
    assert(fs.readdirSync(outside).length === 0, "ancestor symlink target was mutated");

    const bundleLink = makeTarget("reject-bundle-symlink");
    const root = stableRoot(bundleLink);
    const outsideBundle = path.join(tmpRoot, "outside-bundle");
    fs.mkdirSync(outsideBundle);
    fs.mkdirSync(path.join(root, "bundles"), { recursive: true });
    fs.symlinkSync(outsideBundle, path.join(root, "bundles", bundle.bundle_hash), "dir");
    expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: bundleLink, bundle }));
    assert(fs.readdirSync(outsideBundle).length === 0, "bundle symlink target was mutated");
  });

  check("foreign latest symlink is rejected before replacement", () => {
    const target = makeTarget("reject-latest");
    const directory = path.join(stableRoot(target), "bundles", bundle.bundle_hash);
    writeBundle(directory, bundle);
    fs.symlinkSync("../../escape", path.join(stableRoot(target), "latest"), "dir");
    expectFailure(() => publisher.__TEST.materializeBundle({ mode: "preview", targetAbrainHome: target, bundle }));
    assert(fs.readlinkSync(path.join(stableRoot(target), "latest")) === "../../escape", "foreign latest was replaced");
  });

  await asyncCheck("real production L1 publishes exact 1-item preview only into disposable sandbox", async () => {
    const target = makeTarget("real-production-preview");
    const result = await publisher.publishPropositionPolicyStableView({
      mode: "preview", sourceAbrainHome: sourceProduction, repoRoot, sandboxAbrainHome: target,
    });
    assert(result.source_counts.candidates === 1 && result.source_counts.exclusions === 1 && result.source_counts.diagnostics === 1, "real production preview source is not 1/1/1");
    assert(result.source_counts.input_events === 3, "real production preview source input_events is not 3");
    assert(result.stable_item_count === 1 && result.view_utf8_bytes === 341, "real production preview stable view differs");
    assert(result.target_root.startsWith(target), "real production preview escaped sandbox");
  });

  check("concise production authorization accepts only the latest fresh standalone exact role=user phrase", () => {
    const nowMs = Date.now();
    const phrase = publisher.buildStableViewProductionAuthorizationText();
    const candidate = (text, timestamp = new Date(nowMs).toISOString(), content = [{ type: "text", text }]) => ({
      type: "message",
      timestamp,
      message: { role: "user", content },
    });
    assert(phrase === publisher.PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_TEXT, "authorization phrase builder drifted");
    assert(Buffer.byteLength(phrase) === 48, "authorization phrase UTF-8 byte count drifted");
    assert(crypto.createHash("sha256").update(phrase).digest("hex") === "ebd1aafed26d877465e6345b42e096f3d62fe5d9f5fd92eb13b729e175472644", "authorization phrase SHA-256 drifted");
    publisher.__TEST.verifyProductionAuthorizationCandidate(candidate(phrase), nowMs, true);
    const current = expectFailure(() => publisher.__TEST.verifyProductionAuthorizationCandidate(candidate("修正刚实现的 ADR0040 MVP publisher/reader。"), nowMs, true));
    const variant = expectFailure(() => publisher.__TEST.verifyProductionAuthorizationCandidate(candidate(`${phrase} `), nowMs, true));
    const stale = expectFailure(() => publisher.__TEST.verifyProductionAuthorizationCandidate(
      candidate(phrase, new Date(nowMs - publisher.PROPOSITION_POLICY_STABLE_VIEW_PRODUCTION_AUTHORIZATION_MAX_AGE_MS - 1).toISOString()),
      nowMs,
      true,
    ));
    const nonLatest = expectFailure(() => publisher.__TEST.verifyProductionAuthorizationCandidate(candidate(phrase), nowMs, false));
    const nonStandalone = expectFailure(() => publisher.__TEST.verifyProductionAuthorizationCandidate(
      candidate(phrase, new Date(nowMs).toISOString(), [{ type: "text", text: phrase }, { type: "text", text: "extra" }]),
      nowMs,
      true,
    ));
    for (const error of [current, variant, stale, nonLatest, nonStandalone]) {
      assert(error.code === "NOT_AUTHORIZED", `authorization variant did not fail closed: ${error.code || error}`);
    }
  });

  await asyncCheck("production mode is default-denied without a trusted persisted transcript and production target remains absent", async () => {
    const target = publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_HARD_TARGET;
    const before = fs.existsSync(target);
    let caught;
    try {
      await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: sourceProduction, repoRoot });
    } catch (error) { caught = error; }
    assert(caught?.code === "NOT_AUTHORIZED", `expected NOT_AUTHORIZED, got ${caught?.code || caught}`);
    const forged = path.join(tmpRoot, "forged-authorization.jsonl");
    fs.writeFileSync(forged, `${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: publisher.buildStableViewProductionAuthorizationText() }] } })}\n`);
    let forgedCaught;
    try {
      await publisher.publishPropositionPolicyStableView({ mode: "production", sourceAbrainHome: sourceProduction, repoRoot, authorizationTranscriptPath: forged });
    } catch (error) { forgedCaught = error; }
    assert(forgedCaught?.code === "NOT_AUTHORIZED", `forged off-root transcript was accepted: ${forgedCaught?.code || forgedCaught}`);
    assert(fs.existsSync(target) === before, "default-denied production call changed target presence");
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; deterministic 0/1/N-capable compile, P2b1 API alias, no-replace CAS, exact fresh authorization, strict rejection, and real-L1 sandbox preview verified`);
