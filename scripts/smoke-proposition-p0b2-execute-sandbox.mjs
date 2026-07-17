#!/usr/bin/env node
/** ADR0040 P0b2 execute sandbox/adversarial smoke. No real abrain append. */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { snapshotProtectedAbrain, snapshotPropositionProductionTargets } from "./proposition-smoke-protected-snapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const execute = jiti(path.join(repoRoot, "extensions/_shared/proposition-production-execute.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));

const cli = path.join(repoRoot, "scripts/execute-proposition-p0b2-production-genesis.mjs");
const previewDossierPath = path.join(repoRoot, "docs/evidence/2026-07-13-adr0040-p0b2-production-preview-dossier.json");
const registryPath = path.join(repoRoot, "schemas/l1-schema-role-registry.json");
const evidenceDir = path.join(repoRoot, "docs/evidence");
const sessionRoot = "/home/worker/.pi/agent/sessions";
const realAbrain = "/home/worker/.abrain";
const causalAnchorRaw = '<causal_anchor session_id="019f569c-40d3-73f0-9a5f-666b395f6b9a" turn_id="9" subturn="22" sub_agent_label="dispatch_agent"/>';
const runToken = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
const staleSandboxMs = 6 * 60 * 60 * 1000;

let passed = 0;
const failures = [];
const evidenceCleanup = new Set();
const sessionCleanup = new Set();

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

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-proposition-p0b2-execute-${label}-`));
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function snapshotAbrain(root) {
  if (path.resolve(root) === realAbrain) return snapshotPropositionProductionTargets(root, [execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH]);
  return snapshotProtectedAbrain(root);
}

function causalAnchor(raw = causalAnchorRaw) {
  const attr = (name) => new RegExp(`${name}="([^"]+)"`).exec(raw)?.[1] ?? null;
  return {
    raw,
    raw_sha256: sha256(raw),
    session_id: attr("session_id"),
    turn_id: attr("turn_id"),
    subturn: attr("subturn"),
    sub_agent_label: attr("sub_agent_label"),
  };
}

function evidenceOutputPath(label) {
  const safe = label.replace(/[^a-z0-9_.-]/gi, "-");
  const file = path.join(evidenceDir, `tmp-p0b2-execute-${runToken}-${safe}.json`);
  evidenceCleanup.add(file);
  evidenceCleanup.add(intentPathFor(file));
  return file;
}

function repoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function outputBinding(outPath) {
  const rel = repoRelative(outPath);
  return { path: outPath, repo_relative_path: rel, repo_relative_path_sha256: sha256(rel) };
}

function intentPathFor(outPath) {
  const relHash = sha256(repoRelative(outPath)).slice(0, 16);
  return path.join(evidenceDir, `adr0040-p0b2-execution-intent-${execute.PROPOSITION_P0B2_EXPECTED_EVENT_ID.slice(0, 16)}-${relHash}.json`);
}

function durableAtomicCreateTempResidues(targets) {
  const residues = [];
  const byDir = new Map();
  for (const target of targets) {
    const dir = path.dirname(target);
    const list = byDir.get(dir) || [];
    list.push(path.basename(target));
    byDir.set(dir, list);
  }
  for (const [dir, basenames] of byDir) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (basenames.some((base) => durableAtomicCreateTempRegex(base).test(name))) residues.push(path.join(dir, name));
    }
  }
  return residues.sort();
}

function durableAtomicCreateTempRegex(targetBasename) {
  return new RegExp(`^\\.${escapeRegExp(targetBasename)}\\.\\d+\\.\\d+\\.[0-9a-f]{16}\\.tmp$`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function syntheticRatificationRecord(abrainHome, outPath) {
  const targetPath = l1.expectedL1EventPath(abrainHome, execute.PROPOSITION_P0B2_EXPECTED_EVENT_ID);
  const authorizationText = `SYNTHETIC TEST FIXTURE ONLY. NOT VALID FOR ${realAbrain}. Authorizes one sandbox append at ${abrainHome}.`;
  const record = baseRatificationRecord({
    record_kind: "synthetic_test_fixture",
    synthetic_fixture: true,
    synthetic_fixture_scope: {
      valid_for: "test_sandbox_only",
      not_valid_for_abrain_home: realAbrain,
    },
    post_execute_dossier_output: outputBinding(outPath),
    authorization_evidence: {
      evidence_kind: "synthetic_test_fixture",
      authorized_by: "test_fixture",
      authorization_causal_anchor: causalAnchor(),
      authorization_text: authorizationText,
      authorization_text_sha256: sha256(authorizationText),
    },
    authorized_actions: [
      {
        action: "append_l1_event",
        cardinality: "exactly_one",
        abrain_home: abrainHome,
        target_path: targetPath,
        relative_path: execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH,
        event_id: execute.PROPOSITION_P0B2_EXPECTED_EVENT_ID,
        canonical_envelope_bytes_sha256: execute.PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
        allowed_write_statuses: ["created", "identical"],
        prohibited_mutation_classes: ["l2", "state", "rules", "knowledge", "projects", "legacy"],
      },
    ],
  });
  record.record_hash = execute.selfHashRatificationRecord(record);
  return record;
}

function baseRatificationRecord(overrides) {
  return {
    schema_version: execute.PROPOSITION_P0B2_RATIFICATION_RECORD_SCHEMA,
    record_canonicalization: "RFC8785-JCS",
    record_hash_algorithm: "sha256",
    record_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this ratification record object with record_hash omitted",
    record_hash: "",
    preview_dossier: {
      schema_version: "proposition-p0b2-production-preview-dossier/v1",
      dossier_hash: execute.PROPOSITION_P0B2_EXPECTED_PREVIEW_DOSSIER_HASH,
      event_id: execute.PROPOSITION_P0B2_EXPECTED_EVENT_ID,
      canonical_envelope_bytes_sha256: execute.PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
      target_path: execute.PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH,
      relative_path: execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH,
    },
    constraints: {
      no_l2_state_legacy_mutation: true,
      generic_write_gate_must_remain: "L1_SCHEMA_WRITE_DISABLED",
      post_execute_dossier_outside_abrain: true,
      no_runtime_read_flip: true,
      no_legacy_authority_retirement: true,
    },
    ...overrides,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function trustedSessionFixture(text, { anchorRaw = causalAnchorRaw, sessionId = "019f569c-40d3-73f0-9a5f-666b395f6b9a", messageId = "authmsg01", timestamp = "2026-07-13T00:00:00.000Z", includeAnchorRaw = true } = {}) {
  const dir = makeSessionFixtureDir("smoke");
  const file = path.join(dir, `2026-07-13T00-00-00-000Z_${sessionId}.jsonl`);
  const messageText = includeAnchorRaw ? `${anchorRaw}\n${text}` : text;
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-07-13T00:00:00.000Z", cwd: repoRoot },
    { type: "message", id: messageId, parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: messageText }], timestamp: Date.now() } },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return refreshSessionBinding({ dir, file, text: messageText, sessionId, messageId, timestamp, anchorRaw });
}

function refreshSessionBinding(session) {
  const raw = fs.readFileSync(session.file);
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const contentEnd = index > start && raw[index - 1] === 0x0d ? index - 1 : index;
    const text = raw.subarray(start, contentEnd).toString("utf8");
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (parsed?.id === session.messageId) {
        return {
          ...session,
          sessionRelativePath: path.relative(sessionRoot, session.file).split(path.sep).join("/"),
          messageParentId: parsed.parentId ?? null,
          messageLineNumber: lineNumber,
          transcriptPrefixSha256: sha256(raw.subarray(0, index + 1)),
        };
      }
    }
    start = index + 1;
    lineNumber += 1;
  }
  if (start < raw.length) {
    const parsed = JSON.parse(raw.subarray(start).toString("utf8"));
    if (parsed?.id === session.messageId) {
      return {
        ...session,
        sessionRelativePath: path.relative(sessionRoot, session.file).split(path.sep).join("/"),
        messageParentId: parsed.parentId ?? null,
        messageLineNumber: lineNumber,
        transcriptPrefixSha256: sha256(raw.subarray(0)),
      };
    }
  }
  return {
    ...session,
    sessionRelativePath: path.relative(sessionRoot, session.file).split(path.sep).join("/"),
    messageParentId: null,
    messageLineNumber: 1,
    transcriptPrefixSha256: sha256(raw),
  };
}

function realRatificationRecordFromTranscript(session, outPath, { anchor = causalAnchor(session.anchorRaw) } = {}) {
  const record = baseRatificationRecord({
    record_kind: "real_user_ratification",
    synthetic_fixture: false,
    synthetic_fixture_scope: {
      valid_for: "production",
      not_valid_for_abrain_home: null,
    },
    post_execute_dossier_output: outputBinding(outPath),
    authorization_evidence: {
      evidence_kind: "explicit_user_ratification",
      authorized_by: "user",
      transcript_evidence: {
        session_jsonl_path: session.file,
        session_jsonl_relative_path: session.sessionRelativePath,
        session_id: session.sessionId,
        message_id: session.messageId,
        message_parent_id: session.messageParentId,
        message_line_number: session.messageLineNumber,
        timestamp: session.timestamp,
        role: "user",
        text_sha256: sha256(session.text),
        transcript_prefix_sha256: session.transcriptPrefixSha256,
        authorization_causal_anchor: anchor,
      },
    },
    authorized_actions: [
      {
        action: "append_l1_event",
        cardinality: "exactly_one",
        abrain_home: realAbrain,
        target_path: execute.PROPOSITION_P0B2_EXPECTED_REAL_TARGET_PATH,
        relative_path: execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH,
        event_id: execute.PROPOSITION_P0B2_EXPECTED_EVENT_ID,
        canonical_envelope_bytes_sha256: execute.PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256,
        allowed_write_statuses: ["created", "identical"],
        prohibited_mutation_classes: ["l2", "state", "rules", "knowledge", "projects", "legacy"],
      },
    ],
  });
  record.record_hash = execute.selfHashRatificationRecord(record);
  return record;
}

function explicitAuthorizationText(outPath) {
  return execute.buildPropositionP0b2ExactAuthorizationTemplate(outputBinding(outPath));
}

function lineWrappedAuthorizationText(outPath) {
  return explicitAuthorizationText(outPath)
    .replace("canonical envelope bytes sha256=", "canonical envelope bytes\n sha256=")
    .replace("output path=", "output\n path=")
    .replace("output relative path sha256=", "output relative path\n sha256=");
}

function makeSessionFixtureDir(kind) {
  const safeKind = kind.replace(/[^a-z0-9_.-]/gi, "-");
  const dir = fs.mkdtempSync(path.join(sessionRoot, `--p0b2-${safeKind}-${runToken}-`));
  sessionCleanup.add(dir);
  return dir;
}

function cleanupEvidence() {
  for (const file of [...evidenceCleanup].sort((a, b) => b.length - a.length)) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

function cleanupOwnedSessionFixtures() {
  for (const dir of [...sessionCleanup].sort((a, b) => b.length - a.length)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function cleanupStaleSandboxArtifacts() {
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(evidenceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(evidenceDir, entry.name);
      if (/^tmp-p0b2-execute-/.test(entry.name)) {
        const pid = pidFromTokenName(entry.name, /^tmp-p0b2-execute-(\d+)-\d+-[0-9a-f]+-/);
        removeStalePath(full, now, pid);
      } else if (/^adr0040-p0b2-execution-intent-[^/]+\.json$/.test(entry.name)) {
        removeStalePath(full, now, null);
      }
    }
  } catch { /* best effort */ }

  try {
    for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(sessionRoot, entry.name);
      const pid = pidFromTokenName(entry.name, /^--p0b2-(?:smoke|smoke-link)-(\d+)-\d+-[0-9a-f]+-/);
      if (pid === null) continue;
      removeStalePath(full, now, pid, { recursive: true });
    }
  } catch { /* best effort */ }
}

function pidFromTokenName(name, pattern) {
  const match = pattern.exec(name);
  return match ? Number(match[1]) : null;
}

function removeStalePath(file, now, pid, options = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return;
  }
  if (now - stat.mtimeMs < staleSandboxMs) return;
  if (pid !== null && Number.isSafeInteger(pid) && isPidActive(pid)) return;
  try { fs.rmSync(file, { force: true, recursive: options.recursive === true }); } catch { /* best effort */ }
}

function isPidActive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function cleanupAllSandboxArtifacts() {
  cleanupEvidence();
  cleanupOwnedSessionFixtures();
}

cleanupStaleSandboxArtifacts();
process.once("exit", cleanupAllSandboxArtifacts);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupAllSandboxArtifacts();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

console.log("ADR0040 P0b2 production execute sandbox smoke");

await check("sandbox synthetic ratification executes created to identical and writes a valid post dossier", async () => {
  const root = tempRoot("sandbox");
  const abrainHome = path.join(root, "abrain");
  const outPath = evidenceOutputPath("sandbox-post-dossier");
  const ratificationPath = path.join(root, "synthetic-ratification-record.json");
  try {
    fs.mkdirSync(path.join(abrainHome, "l1/events/sha256/39"), { recursive: true });
    const ratification = syntheticRatificationRecord(abrainHome, outPath);
    writeJson(ratificationPath, ratification);
    const before = snapshotAbrain(abrainHome);
    const dossier = await execute.writeProductionExecuteDossier({
      abrainHome,
      previewDossierPath,
      ratificationRecordPath: ratificationPath,
      outputPath: outPath,
      registryPath,
      repoRoot,
      allowSyntheticRatificationForSandboxOnly: true,
    });
    const after = snapshotAbrain(abrainHome);
    const fileDossier = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert(fileDossier.dossier_hash === dossier.dossier_hash, "written post dossier differs from returned dossier");
    assert(execute.validatePostExecuteDossier(fileDossier).length === 0, "post dossier validator returned errors");
    assert(dossier.schema_version === execute.PROPOSITION_P0B2_POST_EXECUTE_DOSSIER_SCHEMA, "post dossier schema drifted");
    assert(dossier.authorization.synthetic_fixture === true, "sandbox dossier did not record synthetic fixture");
    assert(dossier.authorization.production_usable === false, "synthetic fixture was marked production usable");
    assert(dossier.execution_intent.no_replace_status === "created", "intent was not created");
    assert(dossier.write.first_status === "created", `first status=${dossier.write.first_status}`);
    assert(dossier.write.immediate_rerun_status === "identical", `rerun status=${dossier.write.immediate_rerun_status}`);
    assert(dossier.write.created_then_identical === true, "created->identical status missing");
    assert(dossier.readback.byte_identical === true, "readback was not byte-identical");
    assert(dossier.selected_foldable.selected_unchanged === true, "selected set changed");
    assert(dossier.selected_foldable.foldable_unchanged === true, "foldable set changed");
    assert(dossier.surfaces.no_l2_state_or_legacy_change === true, "L2/state/legacy surfaces changed");
    assert(dossier.evidence.no_generic_proposition_write_enablement === true, "generic proposition gate changed");
    assert(dossier.mutation_inventory.only_allowed_mutation === true, "unexpected mutation recorded");
    assert(JSON.stringify(dossier.mutation_inventory.actual_file_creates) === JSON.stringify([execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH]), "actual file create mismatch");
    assert(JSON.stringify(dossier.mutation_inventory.actual_file_modifies) === JSON.stringify([]), "file modifies not empty");
    assert(JSON.stringify(dossier.mutation_inventory.actual_removes) === JSON.stringify([]), "removes not empty");
    assert(dossier.mutation_inventory.allowed_directory_creates.includes("l1/events/sha256/39/75"), "target shard directory materialization not recorded");
    assert(after.count === before.count + 2, `unexpected entry delta before=${before.count} after=${after.count}`);
    const targetPath = path.join(abrainHome, ...execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH.split("/"));
    assert(fs.existsSync(targetPath), "target event file missing");
    assert(sha256(fs.readFileSync(targetPath)) === execute.PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, "target bytes hash mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("existing output dossier is rejected before sandbox mutation", async () => {
  const root = tempRoot("existing-output");
  const abrainHome = path.join(root, "abrain");
  const outPath = evidenceOutputPath("existing-output");
  const ratificationPath = path.join(root, "synthetic-ratification-record.json");
  try {
    fs.mkdirSync(abrainHome, { recursive: true });
    fs.writeFileSync(outPath, "{}\n", "utf8");
    writeJson(ratificationPath, syntheticRatificationRecord(abrainHome, outPath));
    const before = snapshotAbrain(abrainHome);
    let failed = false;
    try {
      await execute.writeProductionExecuteDossier({
        abrainHome,
        previewDossierPath,
        ratificationRecordPath: ratificationPath,
        outputPath: outPath,
        registryPath,
        repoRoot,
        allowSyntheticRatificationForSandboxOnly: true,
      });
    } catch (err) {
      failed = true;
      assert(String(err?.message || err).includes("PROPOSITION_P0B2_OUTPUT_EXISTS"), String(err?.stack || err));
    }
    const after = snapshotAbrain(abrainHome);
    assert(failed, "existing output unexpectedly succeeded");
    assert(before.sha256 === after.sha256 && before.count === after.count, "sandbox abrain changed after existing output rejection");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("event-created dossier failure recovers from valid intent", async () => {
  const root = tempRoot("recovery");
  const abrainHome = path.join(root, "abrain");
  const outPath = evidenceOutputPath("recovery-post-dossier");
  const ratificationPath = path.join(root, "synthetic-ratification-record.json");
  try {
    fs.mkdirSync(path.join(abrainHome, "l1/events/sha256/39"), { recursive: true });
    writeJson(ratificationPath, syntheticRatificationRecord(abrainHome, outPath));
    const first = await execute.executeProductionPropositionGenesis({
      abrainHome,
      previewDossierPath,
      ratificationRecordPath: ratificationPath,
      outputPath: outPath,
      registryPath,
      repoRoot,
      allowSyntheticRatificationForSandboxOnly: true,
    });
    assert(first.write.first_status === "created", "initial execution did not create target");
    assert(!fs.existsSync(outPath), "executeProductionPropositionGenesis wrote a post dossier unexpectedly");
    const recovered = await execute.writeProductionExecuteDossier({
      abrainHome,
      previewDossierPath,
      ratificationRecordPath: ratificationPath,
      outputPath: outPath,
      registryPath,
      repoRoot,
      allowSyntheticRatificationForSandboxOnly: true,
    });
    assert(recovered.write.recovered_from_intent === true, "recovery mode not recorded");
    assert(recovered.write.first_status === "identical", "recovery did not observe identical target");
    assert(recovered.mutation_inventory.only_allowed_mutation === true, "recovery mutation inventory failed");
    assert(fs.existsSync(outPath), "recovery did not write post dossier");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("concurrent identical sandbox executes converge for 20 loops with no durable temp residue", async () => {
  for (let loop = 0; loop < 20; loop += 1) {
    const root = tempRoot(`concurrent-${loop}`);
    const abrainHome = path.join(root, "abrain");
    const outPath = evidenceOutputPath(`concurrent-post-dossier-${loop}`);
    const ratificationPath = path.join(root, "synthetic-ratification-record.json");
    try {
      fs.mkdirSync(path.join(abrainHome, "l1/events/sha256/39"), { recursive: true });
      writeJson(ratificationPath, syntheticRatificationRecord(abrainHome, outPath));
      const opts = {
        abrainHome,
        previewDossierPath,
        ratificationRecordPath: ratificationPath,
        outputPath: outPath,
        registryPath,
        repoRoot,
        allowSyntheticRatificationForSandboxOnly: true,
      };
      const [left, right] = await Promise.all([
        execute.executeProductionPropositionGenesis(opts),
        execute.executeProductionPropositionGenesis(opts),
      ]);
      const statuses = [left.write.first_status, right.write.first_status].sort();
      assert(statuses.includes("created") && statuses.includes("identical"), `loop ${loop}: unexpected statuses ${statuses.join(",")}`);
      assert(left.execution_intent.intent_hash === right.execution_intent.intent_hash, `loop ${loop}: concurrent executions used different intents`);
      const targetPath = path.join(abrainHome, ...execute.PROPOSITION_P0B2_EXPECTED_RELATIVE_PATH.split("/"));
      assert(fs.existsSync(targetPath), `loop ${loop}: concurrent target missing`);
      assert(sha256(fs.readFileSync(targetPath)) === execute.PROPOSITION_P0B2_EXPECTED_CANONICAL_BYTES_SHA256, `loop ${loop}: concurrent target hash mismatch`);
      const residues = durableAtomicCreateTempResidues([targetPath, intentPathFor(outPath), outPath]);
      assert(residues.length === 0, `loop ${loop}: durable temp residue remained: ${JSON.stringify(residues)}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

await check("production CLI fails closed when ratification is missing", () => {
  const outPath = evidenceOutputPath("missing-ratification");
  const before = snapshotAbrain(realAbrain);
  const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--out", outPath]);
  const after = snapshotAbrain(realAbrain);
  assert(result.status !== 0, "missing ratification unexpectedly succeeded");
  assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
  assert(!fs.existsSync(outPath), "missing ratification wrote a post dossier");
  assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed when ratification was missing");
});

await check("production CLI rejects synthetic ratification without mutating real abrain", () => {
  const root = tempRoot("synthetic-rejected");
  const sandboxHome = path.join(root, "synthetic-abrain");
  const outPath = evidenceOutputPath("synthetic-rejected");
  const ratificationPath = path.join(root, "synthetic-ratification-record.json");
  try {
    fs.mkdirSync(sandboxHome, { recursive: true });
    writeJson(ratificationPath, syntheticRatificationRecord(sandboxHome, outPath));
    const before = snapshotAbrain(realAbrain);
    const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationPath, "--out", outPath]);
    const after = snapshotAbrain(realAbrain);
    assert(result.status !== 0, "synthetic ratification unexpectedly succeeded on production path");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(result.stderr.includes("SYNTHETIC_RATIFICATION_REJECTED"), result.stderr);
    assert(!fs.existsSync(outPath), "synthetic production rejection wrote a post dossier");
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed when synthetic ratification was rejected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("forged self-hashed real ratification is rejected without mutating real abrain", () => {
  const root = tempRoot("forged-real");
  const outPath = evidenceOutputPath("forged-real");
  const ratificationPath = path.join(root, "forged-real-ratification.json");
  const session = trustedSessionFixture("I do not authorize this write.");
  try {
    writeJson(ratificationPath, realRatificationRecordFromTranscript(session, outPath));
    const before = snapshotAbrain(realAbrain);
    const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationPath, "--out", outPath]);
    const after = snapshotAbrain(realAbrain);
    assert(result.status !== 0, "forged real ratification unexpectedly succeeded");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(result.stderr.includes("TRANSCRIPT_TEXT_NEGATED_AUTHORIZATION"), result.stderr);
    assert(!fs.existsSync(outPath), "forged real ratification wrote a post dossier");
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for forged real ratification");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

await check("line-wrapped exact authorization normalizes ASCII whitespace before action validation", () => {
  const root = tempRoot("line-wrapped-binding");
  const outPath = evidenceOutputPath("line-wrapped-binding");
  const ratificationPath = path.join(root, "line-wrapped-binding-ratification.json");
  const session = trustedSessionFixture(lineWrappedAuthorizationText(outPath), { includeAnchorRaw: false });
  try {
    const ratification = realRatificationRecordFromTranscript(session, outPath);
    ratification.authorized_actions[0].event_id = "0000000000000000000000000000000000000000000000000000000000000000";
    ratification.record_hash = execute.selfHashRatificationRecord(ratification);
    writeJson(ratificationPath, ratification);
    const before = snapshotAbrain(realAbrain);
    const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationPath, "--out", outPath]);
    const after = snapshotAbrain(realAbrain);
    assert(result.status !== 0, "line-wrapped authorization with bad action unexpectedly succeeded");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(result.stderr.includes("authorized action.event_id mismatch"), result.stderr);
    assert(!result.stderr.includes("TRANSCRIPT_TEXT_NOT_EXPLICIT_AUTHORIZATION"), result.stderr);
    assert(!fs.existsSync(outPath), "line-wrapped bad-action ratification wrote a post dossier");
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for line-wrapped bad action");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

await check("full exact binding with negation is rejected before positive authorization", () => {
  const root = tempRoot("negated-full-binding");
  const outPath = evidenceOutputPath("negated-full-binding");
  const ratificationPath = path.join(root, "negated-full-binding-ratification.json");
  const session = trustedSessionFixture(`${explicitAuthorizationText(outPath)}\n但是我不授权这次写入。`);
  try {
    writeJson(ratificationPath, realRatificationRecordFromTranscript(session, outPath));
    const before = snapshotAbrain(realAbrain);
    const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationPath, "--out", outPath]);
    const after = snapshotAbrain(realAbrain);
    assert(result.status !== 0, "negated full binding unexpectedly succeeded");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(result.stderr.includes("TRANSCRIPT_TEXT_NEGATED_AUTHORIZATION"), result.stderr);
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for negated full binding");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

await check("raw and structured causal anchor mismatch is rejected", () => {
  const root = tempRoot("anchor-mismatch");
  const outPath = evidenceOutputPath("anchor-mismatch");
  const ratificationPath = path.join(root, "anchor-mismatch-ratification.json");
  const session = trustedSessionFixture(explicitAuthorizationText(outPath));
  try {
    const badAnchor = { ...causalAnchor(session.anchorRaw), session_id: "00000000-0000-7000-8000-000000000000" };
    writeJson(ratificationPath, realRatificationRecordFromTranscript(session, outPath, { anchor: badAnchor }));
    const before = snapshotAbrain(realAbrain);
    const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationPath, "--out", outPath]);
    const after = snapshotAbrain(realAbrain);
    assert(result.status !== 0, "anchor mismatch unexpectedly succeeded");
    assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
    assert(result.stderr.includes("session_id"), result.stderr);
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for anchor mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

await check("trusted transcript header, chain, duplicate id, and target membership are enforced", () => {
  const root = tempRoot("transcript-provenance");
  const sessions = [];
  const cases = [];
  try {
    {
      const outPath = evidenceOutputPath("missing-header");
      const session = trustedSessionFixture(explicitAuthorizationText(outPath));
      sessions.push(session);
      const rows = fs.readFileSync(session.file, "utf8").trimEnd().split("\n");
      fs.writeFileSync(session.file, `${rows.slice(1).join("\n")}\n`, "utf8");
      const tampered = refreshSessionBinding(session);
      const ratificationPath = path.join(root, "missing-header.json");
      writeJson(ratificationPath, realRatificationRecordFromTranscript(tampered, outPath));
      cases.push({ label: "missing header", outPath, ratificationPath, reason: "TRANSCRIPT_SESSION_HEADER_MISSING" });
    }
    {
      const outPath = evidenceOutputPath("broken-chain");
      const session = trustedSessionFixture(explicitAuthorizationText(outPath));
      sessions.push(session);
      const rows = fs.readFileSync(session.file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      rows[1].parentId = "missing-parent";
      fs.writeFileSync(session.file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      const tampered = refreshSessionBinding(session);
      const ratificationPath = path.join(root, "broken-chain.json");
      writeJson(ratificationPath, realRatificationRecordFromTranscript(tampered, outPath));
      cases.push({ label: "broken chain", outPath, ratificationPath, reason: "TRANSCRIPT_PARENT_CHAIN_BROKEN" });
    }
    {
      const outPath = evidenceOutputPath("duplicate-id");
      const session = trustedSessionFixture(explicitAuthorizationText(outPath));
      sessions.push(session);
      const rows = fs.readFileSync(session.file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      rows.push({ type: "message", id: session.messageId, parentId: session.messageId, timestamp: "2026-07-13T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "duplicate id" }] } });
      fs.writeFileSync(session.file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      const tampered = refreshSessionBinding(session);
      const ratificationPath = path.join(root, "duplicate-id.json");
      writeJson(ratificationPath, realRatificationRecordFromTranscript(tampered, outPath));
      cases.push({ label: "duplicate id", outPath, ratificationPath, reason: "TRANSCRIPT_DUPLICATE_ID" });
    }
    {
      const outPath = evidenceOutputPath("target-not-in-chain");
      const session = trustedSessionFixture(explicitAuthorizationText(outPath));
      sessions.push(session);
      const missingTarget = { ...session, messageId: "missing-target-message" };
      const ratificationPath = path.join(root, "target-not-in-chain.json");
      writeJson(ratificationPath, realRatificationRecordFromTranscript(missingTarget, outPath));
      cases.push({ label: "target not in chain", outPath, ratificationPath, reason: "TRANSCRIPT_TARGET_NOT_IN_CHAIN" });
    }

    const before = snapshotAbrain(realAbrain);
    for (const item of cases) {
      const result = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", item.ratificationPath, "--out", item.outPath]);
      assert(result.status !== 0, `${item.label} unexpectedly succeeded`);
      assert(result.stderr.includes("NOT_AUTHORIZED"), result.stderr);
      assert(result.stderr.includes(item.reason), `${item.label}: ${result.stderr}`);
      assert(!fs.existsSync(item.outPath), `${item.label} wrote a post dossier`);
    }
    const after = snapshotAbrain(realAbrain);
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for transcript provenance attacks");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const session of sessions) fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

await check("session path escape and symlink evidence are rejected", () => {
  const root = tempRoot("session-path");
  const outPathA = evidenceOutputPath("session-escape");
  const outPathB = evidenceOutputPath("session-symlink");
  const ratificationEscape = path.join(root, "escape.json");
  const ratificationSymlink = path.join(root, "symlink.json");
  const session = trustedSessionFixture(explicitAuthorizationText(outPathB));
  const tmpEscape = path.join(root, "outside-session.jsonl");
  const symlinkDir = makeSessionFixtureDir("smoke-link");
  const symlinkPath = path.join(symlinkDir, "session-link.jsonl");
  try {
    fs.writeFileSync(tmpEscape, fs.readFileSync(session.file));
    fs.symlinkSync(session.file, symlinkPath);
    const escapeSession = { ...session, file: tmpEscape, text: session.text };
    writeJson(ratificationEscape, realRatificationRecordFromTranscript(escapeSession, outPathA));
    const symlinkSession = { ...session, file: symlinkPath };
    writeJson(ratificationSymlink, realRatificationRecordFromTranscript(symlinkSession, outPathB));
    const before = snapshotAbrain(realAbrain);
    const escaped = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationEscape, "--out", outPathA]);
    const symlinked = runCli(["--abrain", realAbrain, "--preview-dossier", previewDossierPath, "--ratification-record", ratificationSymlink, "--out", outPathB]);
    const after = snapshotAbrain(realAbrain);
    assert(escaped.status !== 0 && escaped.stderr.includes("TRANSCRIPT_SESSION_PATH_ESCAPE"), escaped.stderr);
    assert(symlinked.status !== 0 && symlinked.stderr.includes("TRANSCRIPT_SESSION_SYMLINK_REJECTED"), symlinked.stderr);
    assert(before.sha256 === after.sha256 && before.count === after.count, "real abrain changed for bad session paths");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(symlinkDir, { recursive: true, force: true });
  }
});

cleanupAllSandboxArtifacts();
console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  cleanupAllSandboxArtifacts();
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
