#!/usr/bin/env node
/** ADR0040 P0b2 production preview smoke. No real abrain append. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { snapshotPropositionProductionTargets } from "./proposition-smoke-protected-snapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const cli = path.join(repoRoot, "scripts/dossier-proposition-p0b2-production-preview.mjs");
const realAbrain = "/home/worker/.abrain";
const causalAnchor = '<causal_anchor session_id="019f569c-40d3-73f0-9a5f-666b395f6b9a" turn_id="9" subturn="15" sub_agent_label="dispatch_agent"/>';
const expectedEventId = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3";
const expectedCanonicalBytesSha256 = "d9c811f6cef676031a1513e6b1c09f2501b32ff4ea459cca3275c31d56176da5";
const expectedRelativePath = `l1/events/sha256/39/75/${expectedEventId}.json`;
const expectedTargetPath = path.join(realAbrain, ...expectedRelativePath.split("/"));
const committedPreviewDossierPath = path.join(repoRoot, "docs/evidence/2026-07-13-adr0040-p0b2-production-preview-dossier.json");

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function selfHashDossier(dossier) {
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  return jcs.jcsSha256Hex(clone);
}

function tempOut(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p0b2-${label}-`));
  return { dir, out: path.join(dir, "preview-dossier.json") };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
}

console.log("ADR0040 P0b2 production preview smoke");

let previewDossier = null;
let previewOutput = null;
const targetAlreadyCreated = fs.existsSync(expectedTargetPath);

await check("production preview generates a self-hashed dossier without mutating abrain", () => {
  const { dir, out } = tempOut("preview");
  try {
    const before = snapshotPropositionProductionTargets(realAbrain, [expectedRelativePath]);
    const result = runCli(["--preview", "--abrain", realAbrain, "--causal-anchor", causalAnchor, "--out", out, "--compact"]);
    const after = snapshotPropositionProductionTargets(realAbrain, [expectedRelativePath]);
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain owned proposition targets changed during preview");
    if (targetAlreadyCreated) {
      assert(result.status !== 0, "post-execute preview unexpectedly succeeded despite existing target");
      assert(result.stderr.includes("PROPOSITION_P0B2_TARGET_EXISTS"), result.stderr);
      assert(!fs.existsSync(out), "post-execute target-exists preview wrote a dossier");
      assert(sha256(fs.readFileSync(expectedTargetPath)) === expectedCanonicalBytesSha256, "existing production target bytes drifted");
      const committed = JSON.parse(fs.readFileSync(committedPreviewDossierPath, "utf8"));
      assert(committed.dossier_hash === selfHashDossier(committed), "committed preview dossier self hash mismatch");
      previewDossier = committed;
      previewOutput = committedPreviewDossierPath;
      return;
    }
    assert(result.status === 0, `preview exited ${result.status}: ${result.stderr}`);
    const stdoutDossier = JSON.parse(result.stdout);
    const fileDossier = JSON.parse(fs.readFileSync(out, "utf8"));
    assert(stdoutDossier.dossier_hash === selfHashDossier(stdoutDossier), "stdout dossier self hash mismatch");
    assert(fileDossier.dossier_hash === selfHashDossier(fileDossier), "written dossier self hash mismatch");
    assert(stdoutDossier.dossier_hash === fileDossier.dossier_hash, "stdout and written dossier differ");
    assert(stdoutDossier.schema_version === "proposition-p0b2-production-preview-dossier/v1", "schema version drifted");
    assert(stdoutDossier.mode === "preview", "dossier mode is not preview");
    assert(stdoutDossier.authorization.execute_block_code === "NOT_AUTHORIZED", "execute block code missing");
    assert(stdoutDossier.target.abrain_realpath === realAbrain, "realpath gate drifted");
    assert(stdoutDossier.target.target_absent === true, "target is not absent");
    assert(stdoutDossier.preflight.whole_l1.ok === true, "whole-L1 preflight missing");
    assert(stdoutDossier.preflight.zero_proposition_events === true, "real abrain already has proposition events");
    assert(stdoutDossier.preflight.epoch_uniqueness.ok === true, "epoch uniqueness preflight failed");
    assert(stdoutDossier.preflight.registry_schema_binding.ok === true, "registry/schema binding preflight failed");
    assert(stdoutDossier.preflight.generic_validateL1WritePreflight.code === "L1_SCHEMA_WRITE_DISABLED", "generic write preflight did not stay disabled");
    assert(stdoutDossier.expected_mutation_inventory.only_future_file === true, "expected mutation inventory is not one future file");
    assert(stdoutDossier.expected_mutation_inventory.future_file_count === 1, "future file count is not one");
    assert(stdoutDossier.expected_mutation_inventory.l2.length === 0 && stdoutDossier.expected_mutation_inventory.state.length === 0, "expected L2/state mutation leaked in");
    assert(!/sandbox-only|blocked/i.test(stdoutDossier.event.body.producer.version), "producer version still contains sandbox-only/blocked wording");
    assert(!/sandbox-only|blocked/i.test(stdoutDossier.event.body.contract.notes), "immutable notes still contain sandbox-only/blocked wording");
    assert(stdoutDossier.evidence.p0a_p0b1_smoke.p0a.ok === true, "P0a smoke evidence did not pass");
    assert(stdoutDossier.evidence.p0a_p0b1_smoke.p0b1.ok === true, "P0b1 smoke evidence did not pass");
    previewDossier = stdoutDossier;
    previewOutput = out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("default mode is preview", () => {
  const { dir, out } = tempOut("default-preview");
  try {
    const result = runCli(["--abrain", realAbrain, "--causal-anchor", causalAnchor, "--out", out, "--skip-smoke-evidence", "--compact"]);
    if (targetAlreadyCreated) {
      assert(result.status !== 0, "post-execute default preview unexpectedly succeeded despite existing target");
      assert(result.stderr.includes("PROPOSITION_P0B2_TARGET_EXISTS"), result.stderr);
      assert(!fs.existsSync(out), "post-execute default preview wrote a dossier");
      return;
    }
    assert(result.status === 0, `default preview exited ${result.status}: ${result.stderr}`);
    const dossier = JSON.parse(result.stdout);
    assert(dossier.mode === "preview", "default mode did not produce a preview dossier");
    assert(dossier.authorization.preview_only === true, "default preview did not record preview_only");
    assert(dossier.evidence.p0a_p0b1_smoke.p0a.skipped === true, "skip-smoke-evidence flag did not take effect");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("execute is explicitly blocked", () => {
  const { dir, out } = tempOut("execute");
  try {
    const result = runCli(["--execute", "--abrain", realAbrain, "--causal-anchor", causalAnchor, "--out", out]);
    assert(result.status !== 0, "--execute unexpectedly succeeded");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(!fs.existsSync(out), "execute path wrote a dossier");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("real target is required", () => {
  const fakeAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-proposition-p0b2-fake-abrain-"));
  const { dir, out } = tempOut("fake-target");
  try {
    const result = runCli(["--preview", "--abrain", fakeAbrain, "--causal-anchor", causalAnchor, "--out", out]);
    assert(result.status !== 0, "fake abrain target unexpectedly succeeded");
    assert(result.stderr.includes("PROPOSITION_P0B2_REAL_TARGET_REQUIRED"), result.stderr);
    assert(!fs.existsSync(out), "fake target wrote a dossier");
  } finally {
    fs.rmSync(fakeAbrain, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("causal anchor is required", () => {
  const { dir, out } = tempOut("no-anchor");
  try {
    const result = runCli(["--preview", "--abrain", realAbrain, "--out", out]);
    assert(result.status !== 0, "missing causal anchor unexpectedly succeeded");
    assert(result.stderr.includes("PROPOSITION_P0B2_CAUSAL_ANCHOR_REQUIRED"), result.stderr);
    assert(!fs.existsSync(out), "missing causal anchor wrote a dossier");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("preview bytes are identical to sandbox writer bytes", () => {
  assert(previewDossier, "preview dossier was not produced");
  assert(previewDossier.sandbox_equivalence.ok === true, "sandbox equivalence did not pass");
  assert(previewDossier.sandbox_equivalence.event_id_equal === true, "sandbox event_id differs from preview event_id");
  assert(previewDossier.sandbox_equivalence.canonical_bytes_equal === true, "sandbox bytes differ from preview bytes");
  assert(previewDossier.sandbox_equivalence.removed_after === true, "sandbox equivalence temp home was not removed");
  assert(previewDossier.event.event_id === previewDossier.sandbox_equivalence.sandbox_event_id, "dossier event id differs from sandbox event id");
});

await check("output path under abrain is rejected", () => {
  const forbidden = path.join(realAbrain, "p0b2-preview-forbidden.json");
  const result = runCli(["--preview", "--abrain", realAbrain, "--causal-anchor", causalAnchor, "--out", forbidden, "--skip-smoke-evidence"]);
  assert(result.status !== 0, "output under abrain unexpectedly succeeded");
  assert(result.stderr.includes("PROPOSITION_P0B2_OUTPUT_IN_ABRAIN"), result.stderr);
  assert(!fs.existsSync(forbidden), "forbidden abrain output file was created");
});

await check("preview output path stayed outside abrain", () => {
  assert(previewOutput, "preview output path missing");
  assert(!path.resolve(previewOutput).startsWith(`${realAbrain}${path.sep}`), "preview output was under abrain");
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
