#!/usr/bin/env node
/** Focused isolated smoke for Constraint L2 merge-conflict recovery. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "scripts/recover-constraint-l2-merge-conflict.mjs");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, moduleCache: false });
const projection = jiti(path.join(repoRoot, "extensions/sediment/constraint-compiler/projection.ts"));
const render = jiti(path.join(repoRoot, "extensions/sediment/constraint-compiler/render.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const TARGET = "l2/views/constraint/latest/compiled-view.md";
const KNOWLEDGE = "l2/views/knowledge/latest/manifest.json";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-constraint-l2-conflict-recovery-"));
let passed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}

function gitRaw(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(repo, ...args) {
  return gitRaw(repo, ...args).toString("utf8").trim();
}

function writeFile(repo, relative, content) {
  const file = path.join(repo, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function projectionFixture(label, createdAtUtc) {
  const inputRootHash = sha256(`input:${label}`);
  const validationHash = sha256(`validation:${label}`);
  const decision = {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash,
    constraints: [],
    exclusions: [],
    unresolved: [],
    merges: [],
    rescopeProposals: [],
    mappings: [],
    diagnostics: [],
    validationHash,
  };
  const envelope = projection.createConstraintProjectionEnvelope({
    event_schema_version: projection.CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION,
    event_type: "constraint_compiled_view_produced",
    created_at_utc: createdAtUtc,
    device_id: `fixture-${label}`,
    producer_nonce: inputRootHash,
    causal_parents: [sha256(`parent:${label}`)],
    producer: { name: "sediment.constraint-compiler", version: "merge-conflict-smoke" },
    template_version: projection.CONSTRAINT_L2_RENDER_TEMPLATE_VERSION,
    input_root_hash: inputRootHash,
    input_event_ids: [sha256(`input-event:${label}`)],
    provenance: {
      model: "fixture-no-llm",
      prompt_hash: sha256(`prompt:${label}`),
      input_hash: inputRootHash,
      raw_output_hash: sha256(`raw:${label}`),
      parsed_output_hash: validationHash,
      acceptance: "accepted_for_event_append",
    },
    validated_decision: decision,
  });
  return {
    envelope,
    decision,
    eventId: envelope.event_id,
    markdown: render.renderConstraintL2View(decision, envelope.event_id).markdown,
  };
}

function writeEvent(repo, fixture) {
  return writeFile(repo, l1.expectedL1EventRelativePath(fixture.eventId), projection.constraintProjectionEnvelopeJson(fixture.envelope));
}

function commitAll(repo, message) {
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", message);
}

function createConflictRepo(label, options = {}) {
  const repo = path.join(tmp, label);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Constraint L2 Recovery Smoke");
  writeFile(repo, ".gitignore", ".state/\n");
  writeFile(repo, TARGET, "base constraint view\n");
  writeFile(repo, KNOWLEDGE, "{\"branch\":\"base\"}\n");
  if (options.extraConflict) writeFile(repo, "extra-conflict.txt", "base\n");
  commitAll(repo, "base");

  const newer = projectionFixture(`${label}-newer`, "2026-07-18T02:00:00.000Z");
  git(repo, "switch", "-q", "-c", "incoming");
  writeEvent(repo, newer);
  writeFile(repo, TARGET, newer.markdown);
  writeFile(repo, KNOWLEDGE, "{\"branch\":\"incoming\"}\n");
  if (options.extraConflict) writeFile(repo, "extra-conflict.txt", "incoming\n");
  commitAll(repo, "incoming");

  const older = projectionFixture(`${label}-older`, "2026-07-18T01:00:00.000Z");
  git(repo, "switch", "-q", "main");
  writeEvent(repo, older);
  writeFile(repo, TARGET, older.markdown);
  writeFile(repo, KNOWLEDGE, "{\"branch\":\"main\"}\n");
  if (options.extraConflict) writeFile(repo, "extra-conflict.txt", "main\n");
  commitAll(repo, "main");

  const merged = spawnSync("git", ["-C", repo, "merge", "--no-edit", "incoming"], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  assert(merged.status === 1, `fixture merge should conflict, got ${merged.status}: ${merged.stderr}`);
  const unmerged = git(repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean).sort();
  const expected = [TARGET, KNOWLEDGE, ...(options.extraConflict ? ["extra-conflict.txt"] : [])].sort();
  assert(JSON.stringify(unmerged) === JSON.stringify(expected), `unexpected fixture conflicts: ${JSON.stringify(unmerged)}`);
  return { repo, newer, older };
}

function runCli(repo, write = false) {
  const result = spawnSync(process.execPath, [cli, "--abrain", repo, ...(write ? ["--write"] : [])], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  let output;
  const raw = result.status === 0 ? result.stdout.trim() : result.stderr.trim();
  try { output = JSON.parse(raw); }
  catch { throw new Error(`CLI did not emit one machine JSON document (status=${result.status}): stdout=${result.stdout} stderr=${result.stderr}`); }
  if (result.status === 0) assert(result.stderr === "", `successful CLI wrote stderr: ${result.stderr}`);
  else assert(result.stdout === "", `failed CLI wrote stdout: ${result.stdout}`);
  return { ...result, output };
}

function expectError(repo, code) {
  const result = runCli(repo, true);
  assert(result.status !== 0, `expected ${code}, CLI succeeded`);
  assert(result.output.status === "error" && result.output.code === code, `expected ${code}, got ${JSON.stringify(result.output)}`);
  return result.output;
}

function l1Fingerprint(repo) {
  const root = path.join(repo, "l1/events/sha256");
  const rows = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else rows.push(`${path.relative(repo, file)}:${sha256(fs.readFileSync(file))}`);
    }
  };
  walk(root);
  return sha256(JSON.stringify(rows));
}

console.log("smoke: Constraint L2 merge-conflict recovery");

await check("preview is machine JSON and writes zero bytes; write selects merged-worktree latest L1 and leaves both conflicts unstaged", () => {
  const fixture = createConflictRepo("happy");
  const target = path.join(fixture.repo, TARGET);
  const knowledge = path.join(fixture.repo, KNOWLEDGE);
  const beforeTarget = fs.readFileSync(target);
  const beforeKnowledge = fs.readFileSync(knowledge);
  const beforeIndex = gitRaw(fixture.repo, "ls-files", "--stage", "-z");
  const beforeStatus = gitRaw(fixture.repo, "status", "--porcelain=v1", "-z", "-uall");
  const beforeL1 = l1Fingerprint(fixture.repo);

  const preview = runCli(fixture.repo);
  assert(preview.status === 0 && preview.output.status === "preview", `preview failed: ${JSON.stringify(preview.output)}`);
  assert(preview.output.target === TARGET, "preview target mismatch");
  assert(preview.output.source_projection_event_id === fixture.newer.eventId, "preview did not select merged-worktree newest event");
  assert(preview.output.sha256 === sha256(Buffer.from(fixture.newer.markdown)) && preview.output.bytes === Buffer.byteLength(fixture.newer.markdown), "preview hash/bytes mismatch");
  assert(preview.output.current_conflict_status.target_unmerged === true && preview.output.current_conflict_status.knowledge_manifest_unmerged === true, "preview conflict status mismatch");
  assert(fs.readFileSync(target).equals(beforeTarget), "preview changed Constraint target");
  assert(fs.readFileSync(knowledge).equals(beforeKnowledge), "preview changed Knowledge manifest");
  assert(gitRaw(fixture.repo, "ls-files", "--stage", "-z").equals(beforeIndex), "preview changed index");
  assert(gitRaw(fixture.repo, "status", "--porcelain=v1", "-z", "-uall").equals(beforeStatus), "preview changed worktree status");
  assert(l1Fingerprint(fixture.repo) === beforeL1, "preview changed L1");

  const written = runCli(fixture.repo, true);
  assert(written.status === 0 && written.output.status === "written", `write failed: ${JSON.stringify(written.output)}`);
  assert(written.output.source_projection_event_id === fixture.newer.eventId, "write selected wrong source event");
  assert(fs.readFileSync(target, "utf8") === fixture.newer.markdown, "write bytes are not exact renderer output");
  assert(fs.readFileSync(knowledge).equals(beforeKnowledge), "write changed Knowledge manifest");
  assert(gitRaw(fixture.repo, "ls-files", "--stage", "-z").equals(beforeIndex), "write staged or otherwise changed index");
  assert(l1Fingerprint(fixture.repo) === beforeL1, "write changed L1");
  const stillUnmerged = git(fixture.repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean).sort();
  assert(JSON.stringify(stillUnmerged) === JSON.stringify([TARGET, KNOWLEDGE].sort()), `conflicts were unexpectedly resolved: ${stillUnmerged}`);
  assert(written.output.current_conflict_status.target_unmerged === true && written.output.current_conflict_status.knowledge_manifest_unmerged === true, "written conflict status mismatch");
  assert(!fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".tmp")), "temporary file residue remains");
});

await check("write rejects when no merge is active", () => {
  const fixture = createConflictRepo("no-merge");
  git(fixture.repo, "merge", "--abort");
  expectError(fixture.repo, "MERGE_NOT_IN_PROGRESS");
});

await check("write rejects when the target is no longer unmerged", () => {
  const fixture = createConflictRepo("target-resolved");
  git(fixture.repo, "checkout", "--ours", "--", TARGET);
  git(fixture.repo, "add", "--", TARGET);
  expectError(fixture.repo, "TARGET_NOT_UNMERGED");
});

await check("write rejects any unmerged path outside Constraint L2 and Knowledge manifest", () => {
  const fixture = createConflictRepo("extra-conflict", { extraConflict: true });
  expectError(fixture.repo, "UNMERGED_PATH_NOT_ALLOWED");
});

await check("abrain and target symlinks are rejected without following or replacing them", () => {
  const fixture = createConflictRepo("target-symlink");
  const alias = path.join(tmp, "abrain-symlink-alias");
  fs.symlinkSync(fixture.repo, alias, "dir");
  expectError(alias, "ABRAIN_PATH_UNSAFE");

  const target = path.join(fixture.repo, TARGET);
  fs.rmSync(target);
  fs.symlinkSync(path.join(fixture.repo, KNOWLEDGE), target);
  expectError(fixture.repo, "TARGET_PATH_UNSAFE");
  assert(fs.lstatSync(target).isSymbolicLink(), "symlink target was replaced");
});

await check("bad L1 and unknown envelope schema fail the whole canonical scan closed", () => {
  const bad = createConflictRepo("bad-l1");
  writeFile(bad.repo, l1.expectedL1EventRelativePath("a".repeat(64)), "{bad-json\n");
  expectError(bad.repo, "L1_ENVELOPE_INVALID");

  const unknown = createConflictRepo("unknown-schema");
  const foreign = projectionFixture("unknown-envelope", "2026-07-18T03:00:00.000Z");
  const envelope = { ...foreign.envelope, schema: "unknown-constraint-envelope/v1" };
  writeFile(unknown.repo, l1.expectedL1EventRelativePath(foreign.eventId), `${JSON.stringify(envelope)}\n`);
  expectError(unknown.repo, "L1_SCHEMA_UNKNOWN");
});

await check("an attempted duplicate latest event at a second canonical filename is rejected as ambiguous input before selection", () => {
  const fixture = createConflictRepo("ambiguous-latest");
  const duplicatePath = l1.expectedL1EventRelativePath("b".repeat(64));
  writeFile(fixture.repo, duplicatePath, projection.constraintProjectionEnvelopeJson(fixture.newer.envelope));
  expectError(fixture.repo, "L1_PATH_MISMATCH");
});

try {
  if (failures.length) {
    console.log(`\nFAIL - ${failures.length} of ${passed + failures.length} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS - ${passed} focused merge-conflict recovery checks passed`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
