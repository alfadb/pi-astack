#!/usr/bin/env node
/** Canonical-path R3.4.2 P1-S4 isolated shadow chain smoke. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const shadow = jiti(path.join(repoRoot, "extensions/_shared/canonical-shadow-chain.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const constraintRender = jiti(path.join(repoRoot, "extensions/sediment/constraint-compiler/render.ts"));
const knowledgeRender = jiti(path.join(repoRoot, "extensions/sediment/knowledge-evidence.ts"));
const evidenceManifestPath = path.join(repoRoot, "docs/evidence/2026-07-11-canonical-path-p1-s4-production-shadow-manifest.json");
const sha256Pattern = /^[0-9a-f]{64}$/;

let passed = 0;
const failures = [];
const cleanup = [];

function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

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

async function expectFailure(fn, code) {
  let caught;
  try { await fn(); } catch (err) { caught = err; }
  assert(caught, `expected failure${code ? ` ${code}` : ""}, operation succeeded`);
  if (code) assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  return caught;
}

function temp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-s4-${label}-`));
  cleanup.push(dir);
  return dir;
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function envelope(schema, body) {
  const bodyHash = l1.canonicalL1BodyHash(body);
  return { schema, canonicalization: "RFC8785-JCS", hash_alg: "sha256", event_id: bodyHash, body_hash: bodyHash, body };
}

function eventPath(home, eventId) {
  return path.join(home, ...l1.expectedL1EventRelativePath(eventId).split("/"));
}

function writeEvent(home, value) {
  const file = eventPath(home, value.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${jcs.canonicalizeJcs(value)}\n`, "utf8");
  return file;
}

function commitEvent(home, value, message) {
  const file = writeEvent(home, value);
  const relative = path.relative(home, file).split(path.sep).join("/");
  git(home, "add", relative);
  git(home, "commit", "-q", "-m", message, "--only", "--", relative);
  return file;
}

function projectionFixture(label = "committed") {
  const inputRootHash = jcs.sha256Hex(`input-${label}`);
  const validationHash = jcs.sha256Hex(`validation-${label}`);
  return envelope("constraint-projection-envelope/v1", {
    event_schema_version: "constraint-projection-event/v1",
    event_type: "constraint_compiled_view_produced",
    created_at_utc: "2026-07-11T00:00:00.000Z",
    device_id: "canonical-shadow-smoke",
    producer_nonce: inputRootHash,
    causal_parents: [jcs.sha256Hex(`parent-${label}`)],
    producer: { name: "sediment.constraint-compiler", version: "smoke" },
    template_version: "constraint-shadow-render/v1",
    input_root_hash: inputRootHash,
    input_event_ids: [jcs.sha256Hex(`input-event-${label}`)],
    provenance: {
      model: "historical-production-model",
      prompt_hash: jcs.sha256Hex(`prompt-${label}`),
      input_hash: inputRootHash,
      raw_output_hash: jcs.sha256Hex(`raw-${label}`),
      parsed_output_hash: validationHash,
      acceptance: "accepted_for_event_append",
    },
    validated_decision: {
      schemaVersion: "constraint-shadow-decision/v1",
      inputRootHash,
      constraints: [], exclusions: [], unresolved: [], merges: [], rescopeProposals: [], mappings: [], diagnostics: [],
      validationHash,
    },
  });
}

function knowledgeFixture(overrides = {}) {
  const base = {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: "2026-07-11T00:00:00.000Z",
    device_id: "canonical-shadow-smoke",
    producer_nonce: "knowledge-smoke",
    causal_parents: [],
    session_id: "s4-smoke-session",
    turn_id: "s4-smoke-turn",
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "replay", source_ref: "s4-smoke" },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: { kind: "world" },
    payload: {
      slug: "canonical-shadow-smoke", title: "Canonical shadow smoke", kind: "fact", status: "active",
      provenance: "synthetic fixture", confidence: 1, compiled_truth: "fixture-compiled-truth-never-copied-into-genesis",
      trigger_phrases: [], derives_from: [],
    },
    sanitizer: { sanitizer_name: "smoke", sanitizer_version: "1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "not_attempted" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
  const body = {
    ...base,
    ...overrides,
    intent: { ...base.intent, ...(overrides.intent || {}) },
    payload: { ...base.payload, ...(overrides.payload || {}) },
  };
  return envelope("knowledge-evidence-envelope/v1", body);
}

function createSourceRepo() {
  const root = temp("source");
  const remote = temp("remote");
  git(root, "init", "-q", "--initial-branch=main");
  git(remote, "init", "-q", "--bare", "--initial-branch=main");
  git(root, "config", "user.email", "smoke@example.invalid");
  git(root, "config", "user.name", "Canonical Shadow Smoke");
  git(root, "remote", "add", "origin", remote);
  const knowledge = knowledgeFixture();
  const projection = projectionFixture();
  writeEvent(root, knowledge);
  writeEvent(root, projection);
  const knowledgeProjection = knowledgeRender.renderKnowledgeProjectionFromSet([{ eventId: knowledge.event_id, body: knowledge.body }]);
  const compiledL2 = constraintRender.renderConstraintL2View(projection.body.validated_decision, projection.event_id).markdown;
  for (const [relative, content] of [
    ["rules/base.md", "# rule fixture\n"],
    ["knowledge/base.md", "# knowledge fixture\n"],
    ["projects/pi-global/base.md", "# project fixture\n"],
    ["l2/views/constraint/latest/compiled-view.md", compiledL2],
    ["l2/views/knowledge/latest/world/canonical-shadow-smoke.md", knowledgeProjection.markdown],
    [".state/sediment/constraint-shadow/latest/compiled-view.md", "runtime compiled bundle fixture\n"],
    [".state/sediment/constraint-shadow/latest/decision.json", "{\"fixture\":true}\n"],
    ["read-config.json", `${JSON.stringify({ ruleInjector: { compiledViewInjection: { enabled: true } }, sediment: { knowledgeProjector: { canonicalReadMode: "projection_only", l2OutputRoot: "repo" } } }, null, 2)}\n`],
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture source");
  git(remote, "fetch", "-q", root, "HEAD:refs/heads/main");
  fs.writeFileSync(path.join(root, "staged-preserved.txt"), "staged\n");
  git(root, "add", "staged-preserved.txt");
  fs.writeFileSync(path.join(root, "dirty-preserved.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "l2/views/constraint/latest/compiled-view.md"), "dirty derived L2 worktree bytes\n", "utf8");
  return { root, remote, knowledge, projection, readConfigPath: path.join(root, "read-config.json") };
}

async function completeKnowledgeChain(source, shadowHome, runId) {
  const candidate = await shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: source.root, shadowAbrainHome: shadowHome, runId, sourceEventId: source.knowledge.event_id,
  });
  const attempt = await shadow.claimKnowledgeCuratorAttempt({
    shadowAbrainHome: shadowHome, runId, candidateEventId: candidate.eventId, slot: 1,
    frozenCuratorInputHash: candidate.frozenCuratorInputHash,
  });
  const decision = await shadow.createKnowledgeCuratorDecision({
    shadowAbrainHome: shadowHome, runId, candidateEventId: candidate.eventId, attemptEventId: attempt.eventId, decision: "accept",
  });
  const receipt = await shadow.createKnowledgeApplyReceipt({ shadowAbrainHome: shadowHome, runId, decisionEventId: decision.eventId });
  return { candidate, attempt, decision, receipt };
}

console.log("canonical-path P1-S4 shadow smoke");
const source = createSourceRepo();

await check("five S4 schemas remain phase_disabled and canonical write preflight rejects them", async () => {
  const registry = l1.loadL1SchemaRegistry();
  for (const schema of shadow.CANONICAL_SHADOW_SCHEMAS) {
    const entry = registry.entries.find((item) => item.envelope_schema === schema);
    assert(entry?.phase === "phase_disabled" && entry.write_enabled === false && entry.fold_eligible === false, `${schema} activated`);
  }
  const future = envelope("knowledge-candidate-observation/v1", { fixture: "canonical-write-forbidden" });
  const target = eventPath(source.root, future.event_id);
  await expectFailure(() => l1.validateL1WritePreflight({ abrainHome: source.root, envelope: future, targetPath: target }), "L1_SCHEMA_WRITE_DISABLED");
});

await check("full E1-attempt-E2-E3 chain is isolated, content-addressed, and validates", async () => {
  const home = temp("full-chain");
  const chain = await completeKnowledgeChain(source, home, "full-chain");
  const validated = await shadow.validateKnowledgeShadowChain({ shadowAbrainHome: home, runId: "full-chain" });
  assert(validated.candidate.eventId === chain.candidate.eventId, "candidate id mismatch");
  assert(validated.decision.eventId === chain.decision.eventId, "decision id mismatch");
  assert(validated.receipt.eventId === chain.receipt.eventId, "receipt id mismatch");
  assert(chain.decision.envelope.body.canonical_fold_eligible === false, "decision became fold eligible");
  assert(chain.receipt.envelope.body.zero_canonical_apply === true, "receipt is not zero apply");
  const expectedRoot = path.join(home, "l2", "shadow", "r3", "knowledge", "full-chain");
  assert(chain.candidate.filePath.startsWith(`${expectedRoot}${path.sep}events${path.sep}sha256${path.sep}`), "wrong physical shadow root");
});

await check("eight concurrent deterministic attempt claims have one winner and seven consumed", async () => {
  const home = temp("claim-race");
  const candidate = await shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "claim-race", sourceEventId: source.knowledge.event_id,
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => shadow.claimKnowledgeCuratorAttempt({
    shadowAbrainHome: home, runId: "claim-race", candidateEventId: candidate.eventId, slot: 2,
    frozenCuratorInputHash: candidate.frozenCuratorInputHash,
  })));
  assert(results.filter((item) => item.claimStatus === "winner").length === 1, "claim race did not produce one winner");
  assert(results.filter((item) => item.claimStatus === "consumed").length === 7, "claim race did not consume seven losers");
  assert(new Set(results.map((item) => item.eventId)).size === 1, "claim bytes are not deterministic");
});

await check("knowledge chain validator rejects attempt slot gaps", async () => {
  const home = temp("attempt-gap");
  const candidate = await shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "attempt-gap", sourceEventId: source.knowledge.event_id,
  });
  const attempt = await shadow.claimKnowledgeCuratorAttempt({
    shadowAbrainHome: home, runId: "attempt-gap", candidateEventId: candidate.eventId, slot: 2,
    frozenCuratorInputHash: candidate.frozenCuratorInputHash,
  });
  const decision = await shadow.createKnowledgeCuratorDecision({
    shadowAbrainHome: home, runId: "attempt-gap", candidateEventId: candidate.eventId, attemptEventId: attempt.eventId, decision: "accept",
  });
  await shadow.createKnowledgeApplyReceipt({ shadowAbrainHome: home, runId: "attempt-gap", decisionEventId: decision.eventId });
  await expectFailure(() => shadow.validateKnowledgeShadowChain({ shadowAbrainHome: home, runId: "attempt-gap" }), "SHADOW_CHAIN_ORDER");
});

await check("missing links and rendered-output hash damage fail closed", async () => {
  const missingHome = temp("missing-link");
  await shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: source.root, shadowAbrainHome: missingHome, runId: "missing-link", sourceEventId: source.knowledge.event_id,
  });
  await expectFailure(() => shadow.validateKnowledgeShadowChain({ shadowAbrainHome: missingHome, runId: "missing-link" }), "SHADOW_CHAIN_INCOMPLETE");

  const hashHome = temp("hash-damage");
  const chain = await completeKnowledgeChain(source, hashHome, "hash-damage");
  fs.writeFileSync(chain.receipt.outputPath, "tampered\n", "utf8");
  await expectFailure(() => shadow.validateKnowledgeShadowChain({ shadowAbrainHome: hashHome, runId: "hash-damage" }), "SHADOW_OUTPUT_HASH_MISMATCH");
});

await check("run-id path escape and symlinked shadow path are rejected", async () => {
  assert((await expectFailure(() => Promise.resolve(shadow.canonicalShadowRunRoot(temp("escape"), "knowledge", "../escape")))).code === "SHADOW_RUN_ID_INVALID", "path escape did not fail by run id");
  const home = temp("symlink");
  const outside = temp("outside");
  fs.symlinkSync(outside, path.join(home, "l2"), "dir");
  await expectFailure(() => shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "symlink-run", sourceEventId: source.knowledge.event_id,
  }), "SHADOW_SYMLINK_REJECTED");

  const lexicalTmp = temp("tmp-realpath");
  const parentLink = path.join(lexicalTmp, "outside-parent");
  fs.symlinkSync(os.homedir(), parentLink, "dir");
  await expectFailure(
    () => shadow.initializeCanonicalShadowHome(path.join(parentLink, ".pi"), true),
    "SHADOW_HOME_NOT_TEMP",
  );

  const unsafeSource = createSourceRepo();
  fs.symlinkSync(path.join(unsafeSource.root, "read-config.json"), path.join(unsafeSource.root, "untracked-link.json"));
  await expectFailure(
    () => shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: unsafeSource.root, readConfigPath: unsafeSource.readConfigPath }),
    "SHADOW_SOURCE_UNSAFE",
  );
});

await check("dirty derived L2 still creates zero-delta genesis anchored only to committed HEAD bytes", async () => {
  const home = temp("genesis");
  const result = await shadow.createConstraintGenesis({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "genesis-run",
    projectionEventId: source.projection.event_id,
    sourceL2RelativePath: "l2/views/constraint/latest/compiled-view.md",
  });
  await shadow.validateConstraintGenesis({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "genesis-run", genesisEventId: result.eventId,
  });
  const injectedBody = JSON.parse(JSON.stringify(result.envelope.body));
  injectedBody.payload = { compiled_truth: "must-fail-closed" };
  const injected = envelope("constraint-genesis/v1", injectedBody);
  const injectedPath = path.join(
    home, "l2", "shadow", "r3", "constraint", "genesis-run", "events", "sha256",
    injected.event_id.slice(0, 2), injected.event_id.slice(2, 4), `${injected.event_id}.json`,
  );
  fs.mkdirSync(path.dirname(injectedPath), { recursive: true });
  fs.writeFileSync(injectedPath, `${jcs.canonicalizeJcs(injected)}\n`, "utf8");
  const injectedFailure = await expectFailure(() => shadow.validateConstraintGenesis({
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "genesis-run", genesisEventId: injected.event_id,
  }));
  assert(
    ["SHADOW_GENESIS_COMPILED_CONTENT", "SHADOW_BODY_INVALID"].includes(injectedFailure.code),
    `extra genesis field did not fail closed: ${injectedFailure.code || injectedFailure.message}`,
  );
  const text = fs.readFileSync(result.filePath, "utf8");
  assert(!text.includes("validated_decision"), "genesis copied validated decision");
  assert(!text.includes("dirty derived L2 worktree bytes"), "genesis copied dirty worktree L2 content");
  assert(result.envelope.body.historical_llm_rerun === false, "genesis claims historical LLM rerun");
  assert(result.envelope.body.canonical_delta_expected === 0, "genesis expects canonical delta");
  assert(result.sourceL2.blobOid && result.sourceL2.blobSha256, "committed source L2 anchors missing");
  assert(result.sourceL2.worktree_matches_head === false, "dirty L2 was falsely reported as matching HEAD");
  assert(result.envelope.body.committed_l2_sha256 === result.sourceL2.blobSha256, "genesis did not anchor committed L2 SHA");
  assert(result.envelope.body.rerendered_l2_sha256 === result.sourceL2.blobSha256 && result.envelope.body.byte_equal === true, "genesis lacks true byte equality proof");
});

await check("committed L2 rerender mismatch fails explicit genesis and implicit selection falls back by decision hash", async () => {
  const mismatch = createSourceRepo();
  const l2Relative = "l2/views/constraint/latest/compiled-view.md";
  fs.writeFileSync(path.join(mismatch.root, l2Relative), "committed mismatch bytes\n", "utf8");
  git(mismatch.root, "add", l2Relative);
  git(mismatch.root, "commit", "-q", "-m", "mismatched committed L2", "--only", "--", l2Relative);
  await expectFailure(() => shadow.createConstraintGenesis({
    sourceAbrainHome: mismatch.root, shadowAbrainHome: temp("l2-mismatch"), runId: "l2-mismatch",
    projectionEventId: mismatch.projection.event_id,
  }), "SHADOW_GENESIS_L2_RERENDER_MISMATCH");

  const fallback = createSourceRepo();
  const newerBody = JSON.parse(JSON.stringify(projectionFixture("newer-nonmatching").body));
  newerBody.created_at_utc = "2026-07-11T01:00:00.000Z";
  const newer = envelope("constraint-projection-envelope/v1", newerBody);
  commitEvent(fallback.root, newer, "newer nonmatching projection");
  const selected = await shadow.selectConstraintGenesisProjection({ sourceAbrainHome: fallback.root });
  assert(selected.projection.eventId === fallback.projection.event_id, "implicit genesis did not select latest committed projection matching committed L2");
});

await check("explicit uncommitted projection cannot become genesis", async () => {
  const uncommitted = projectionFixture("uncommitted");
  const file = writeEvent(source.root, uncommitted);
  try {
    await expectFailure(() => shadow.createConstraintGenesis({
      sourceAbrainHome: source.root, shadowAbrainHome: temp("uncommitted-genesis"), runId: "uncommitted-genesis",
      projectionEventId: uncommitted.event_id,
    }));
  } finally {
    fs.rmSync(file, { force: true });
    const second = path.dirname(file);
    const first = path.dirname(second);
    if (fs.existsSync(second) && fs.readdirSync(second).length === 0) fs.rmdirSync(second);
    if (fs.existsSync(first) && fs.readdirSync(first).length === 0) fs.rmdirSync(first);
  }
});

await check("knowledge source must be the committed active fold winner, never a superseded or deleted event", async () => {
  const nonwinner = createSourceRepo();
  const update = knowledgeFixture({
    created_at_utc: "2026-07-11T02:00:00.000Z",
    producer_nonce: "knowledge-update",
    causal_parents: [nonwinner.knowledge.event_id],
    intent: { operation_hint: "update" },
    payload: { title: "Updated canonical winner", compiled_truth: "updated accepted fold winner" },
  });
  commitEvent(nonwinner.root, update, "knowledge update winner");
  await expectFailure(() => shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: nonwinner.root, shadowAbrainHome: temp("knowledge-nonwinner"), runId: "knowledge-nonwinner",
    sourceEventId: nonwinner.knowledge.event_id,
  }), "SHADOW_KNOWLEDGE_SOURCE_NOT_ACTIVE_WINNER");
  const accepted = await shadow.createKnowledgeCandidateObservation({
    sourceAbrainHome: nonwinner.root, shadowAbrainHome: temp("knowledge-winner"), runId: "knowledge-winner",
    sourceEventId: update.event_id,
  });
  assert(accepted.fold.winnerEventId === update.event_id && accepted.envelope.body.provenance.mode === "replay-existing-accepted-fold-winner", "active winner provenance is wrong");

  const deleted = createSourceRepo();
  const tombstone = knowledgeFixture({
    created_at_utc: "2026-07-11T03:00:00.000Z",
    producer_nonce: "knowledge-delete",
    causal_parents: [deleted.knowledge.event_id],
    intent: { operation_hint: "delete" },
    payload: { status: "archived", compiled_truth: "deleted" },
  });
  commitEvent(deleted.root, tombstone, "knowledge delete winner");
  for (const eventId of [deleted.knowledge.event_id, tombstone.event_id]) {
    await expectFailure(() => shadow.createKnowledgeCandidateObservation({
      sourceAbrainHome: deleted.root, shadowAbrainHome: temp("knowledge-deleted"), runId: `deleted-${eventId.slice(0, 8)}`,
      sourceEventId: eventId,
    }), "SHADOW_KNOWLEDGE_SOURCE_NOT_ACTIVE_WINNER");
  }
});

await check("incomplete committed decision and source HEAD drift both invalidate genesis", async () => {
  const driftSource = createSourceRepo();
  const incompleteBody = JSON.parse(JSON.stringify(driftSource.projection.body));
  delete incompleteBody.validated_decision.validationHash;
  const incomplete = envelope("constraint-projection-envelope/v1", incompleteBody);
  const incompleteFile = writeEvent(driftSource.root, incomplete);
  const incompleteRelative = path.relative(driftSource.root, incompleteFile).split(path.sep).join("/");
  git(driftSource.root, "add", incompleteRelative);
  git(driftSource.root, "commit", "-q", "-m", "incomplete projection fixture", "--only", "--", incompleteRelative);
  await expectFailure(() => shadow.createConstraintGenesis({
    sourceAbrainHome: driftSource.root, shadowAbrainHome: temp("incomplete-decision"), runId: "incomplete-decision",
    projectionEventId: incomplete.event_id,
  }), "SHADOW_BODY_INVALID");

  const home = temp("ref-drift");
  const genesis = await shadow.createConstraintGenesis({
    sourceAbrainHome: driftSource.root, shadowAbrainHome: home, runId: "ref-drift",
    projectionEventId: driftSource.projection.event_id,
  });
  const driftFile = path.join(driftSource.root, "ref-drift.txt");
  fs.writeFileSync(driftFile, "advance source head\n", "utf8");
  git(driftSource.root, "add", "ref-drift.txt");
  git(driftSource.root, "commit", "-q", "-m", "advance source ref", "--only", "--", "ref-drift.txt");
  await expectFailure(() => shadow.validateConstraintGenesis({
    sourceAbrainHome: driftSource.root, shadowAbrainHome: home, runId: "ref-drift", genesisEventId: genesis.eventId,
  }), "SHADOW_SOURCE_REF_DRIFT");
});

await check("actual canonical read bundles, pure fold output, and untracked bytes drive change detection", async () => {
  const readBefore = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  const runtimeBundle = path.join(source.root, ".state/sediment/constraint-shadow/latest/compiled-view.md");
  const runtimeOriginal = fs.readFileSync(runtimeBundle);
  fs.writeFileSync(runtimeBundle, "mutated runtime read bundle\n", "utf8");
  const readAfter = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  assert(shadow.compareCanonicalSourceSnapshots(readBefore, readAfter).readChanged === true, "actual read bundle mutation did not set readChanged");
  fs.writeFileSync(runtimeBundle, runtimeOriginal);

  const foldBefore = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  const foldUpdate = knowledgeFixture({
    created_at_utc: "2026-07-11T04:00:00.000Z",
    producer_nonce: "fold-output-tamper",
    causal_parents: [source.knowledge.event_id],
    intent: { operation_hint: "update" },
    payload: { title: "Fold output changed", compiled_truth: "fold output tamper fixture" },
  });
  const foldFile = writeEvent(source.root, foldUpdate);
  const foldAfter = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  const foldChanges = shadow.compareCanonicalSourceSnapshots(foldBefore, foldAfter);
  assert(foldChanges.foldChanged === true && foldBefore.fold_output_hash !== foldAfter.fold_output_hash, "pure knowledge fold output mutation did not set foldChanged");
  fs.rmSync(foldFile, { force: true });

  const untrackedBefore = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  fs.writeFileSync(path.join(source.root, "dirty-preserved.txt"), "same path, changed untracked bytes\n", "utf8");
  const untrackedAfter = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  assert(shadow.compareCanonicalSourceSnapshots(untrackedBefore, untrackedAfter).worktreeChanged === true, "untracked content mutation was hidden by stable status path");
  assert(untrackedBefore.untracked_content_hash !== untrackedAfter.untracked_content_hash, "untracked content hash did not change");
  fs.writeFileSync(path.join(source.root, "dirty-preserved.txt"), "dirty\n", "utf8");
});

await check("phase-disabled events leaked into canonical L1 fail dossier before shadow work", async () => {
  const leaked = createSourceRepo();
  const phaseDisabled = envelope("knowledge-candidate-observation/v1", { fixture: "canonical-phase-disabled-leak" });
  writeEvent(leaked.root, phaseDisabled);
  await expectFailure(() => shadow.createCanonicalPathShadowDossier({
    sourceAbrainHome: leaked.root,
    shadowAbrainHome: temp("phase-leak-shadow"),
    runId: "phase-leak",
    knowledgeEventId: leaked.knowledge.event_id,
    projectionEventId: leaked.projection.event_id,
    readConfigPath: leaked.readConfigPath,
  }), "SHADOW_CANONICAL_PHASE_DISABLED_LEAK");
});

await check("dossier is deterministic and proves source/ref/index/worktree/push/canonical/read/fold zero impact", async () => {
  const home = temp("dossier");
  const before = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  const options = {
    sourceAbrainHome: source.root, shadowAbrainHome: home, runId: "deterministic-dossier",
    knowledgeEventId: source.knowledge.event_id, projectionEventId: source.projection.event_id,
    sourceL2RelativePath: "l2/views/constraint/latest/compiled-view.md", readConfigPath: source.readConfigPath,
  };
  const first = await shadow.createCanonicalPathShadowDossier(options);
  const bytesA = fs.readFileSync(first.reportPath, "utf8");
  const second = await shadow.createCanonicalPathShadowDossier(options);
  const bytesB = fs.readFileSync(second.reportPath, "utf8");
  const after = await shadow.captureCanonicalSourceSnapshot({ sourceAbrainHome: source.root, readConfigPath: source.readConfigPath });
  assert(bytesA === bytesB, "same dossier inputs did not reproduce identical bytes");
  assert(first.reportStatus === "created" && second.reportStatus === "identical", "dossier no-replace status mismatch");
  assert(first.ok && second.ok, "dossier reported source impact");
  assert(shadow.validateCanonicalShadowDossierSelfHash(first.report), "dossier self hash invalid");
  assert(first.report.phase_disabled_shadow_count_before === 0 && first.report.phase_disabled_shadow_count_after === 0, "dossier did not prove zero canonical phase-disabled shadows");
  assert(String(first.report.report_file_sha256_rule).includes("recorded externally"), "report file hash rule is missing");
  assert(first.report.source_before.canonical_read.bundles.knowledge.files > 0, "knowledge read bundle was not hashed");
  assert(first.report.source_before.canonical_read.bundles.constraint.files > 0, "constraint read bundle was not hashed");
  const foldProjection = knowledgeRender.renderKnowledgeProjectionFromSet([{ eventId: source.knowledge.event_id, body: source.knowledge.body }]);
  const foldIdentity = knowledgeRender.knowledgeIdentityKey(source.knowledge.body);
  const expectedFoldInputHash = jcs.jcsSha256Hex({
    knowledge: [{ identity: foldIdentity, input_event_ids: [source.knowledge.event_id], input_event_set_hash: foldProjection.inputEventSetHash }],
    constraint_projection_event_ids: [source.projection.event_id],
  });
  const expectedDecisionHash = constraintRender.renderConstraintL2View(source.projection.body.validated_decision, source.projection.event_id).decisionHash;
  const expectedFoldOutputHash = jcs.jcsSha256Hex({
    knowledge: [{
      identity: foldIdentity,
      winner_event_id: foldProjection.winnerEventId,
      input_event_ids: [source.knowledge.event_id],
      input_event_set_hash: foldProjection.inputEventSetHash,
      output_kind: foldProjection.kind,
      output_markdown_sha256: jcs.sha256Hex(foldProjection.markdown),
    }],
    constraint_decision_hashes: [expectedDecisionHash],
  });
  for (const snapshot of [first.report.source_before, first.report.source_after]) {
    assert(!Object.hasOwn(snapshot.canonical_fold, "knowledge"), "dossier embeds canonical_fold.knowledge rows");
    assert(snapshot.canonical_fold.knowledge_identity_count === 1, "knowledge identity count mismatch");
    assert(snapshot.canonical_fold.knowledge_event_count === 1, "knowledge event count mismatch");
    assert(snapshot.canonical_fold.constraint_projection_count === 1, "constraint projection count mismatch");
    assert(snapshot.fold_input_set_hash === expectedFoldInputHash, "fold input hash formula changed");
    assert(snapshot.fold_output_hash === expectedFoldOutputHash, "fold output hash formula changed");
  }
  assert(Buffer.byteLength(bytesA) < 200 * 1024, `fixture dossier is too large: ${Buffer.byteLength(bytesA)} bytes`);
  for (const field of ["sourceChanged", "refChanged", "indexChanged", "worktreeChanged", "pushChanged", "canonicalChanged", "readChanged", "foldChanged"]) {
    assert(first.report[field] === false, `${field} is not false`);
  }
  assert(before.snapshot_hash === after.snapshot_hash, "source snapshot changed");
  assert(git(source.root, "status", "--porcelain").includes("staged-preserved.txt"), "preexisting staged file was lost");
  assert(git(source.root, "status", "--porcelain").includes("dirty-preserved.txt"), "preexisting dirty file was lost");
});

await check("production S4 evidence manifest is self-contained and records zero source impact", async () => {
  const manifest = JSON.parse(fs.readFileSync(evidenceManifestPath, "utf8"));
  assert(manifest.schema_version === "canonical-path-p1-s4-production-evidence/v1", "manifest schema mismatch");
  assert(manifest.production_report.run_id === "p1-s4-production-final", "manifest run id mismatch");
  assert(sha256Pattern.test(manifest.production_report.exact_bytes_sha256), "report SHA-256 shape invalid");
  assert(manifest.production_report.exact_bytes === 73812, "report byte count mismatch");
  assert(!Object.hasOwn(manifest, "manifest_sha") && !Object.hasOwn(manifest, "manifest_sha256"), "manifest embeds a forged self hash");
  for (const field of ["sourceChanged", "refChanged", "indexChanged", "worktreeChanged", "pushChanged", "canonicalChanged", "readChanged", "foldChanged"]) {
    assert(manifest.impact_flags[field] === false, `manifest ${field} is not false`);
  }
  const before = manifest.source_immutability.before;
  const after = manifest.source_immutability.after;
  for (const field of [
    "source_git_head", "source_ref", "snapshot_hash", "refs_hash", "index_hash", "index_status_hash",
    "worktree_status_hash", "untracked_content_hash", "push_remote_refs_hash", "canonical_trees_hash",
    "l1_event_set_hash", "l1_event_count", "fold_input_set_hash", "fold_output_hash", "fold_event_count",
    "canonical_read_hash", "phase_disabled_shadow_count", "phase_disabled_shadow_ids_hash",
  ]) assert(before[field] === after[field], `manifest source before/after mismatch: ${field}`);
  assert(before.phase_disabled_shadow_count === 0, "manifest phase-disabled canonical leak count is nonzero");
  assert(jcs.canonicalizeJcs(before.canonical_trees) === jcs.canonicalizeJcs(after.canonical_trees), "manifest canonical trees changed");
  const chain = manifest.knowledge.chain;
  for (const field of ["e1_candidate_event_id", "e2_decision_event_id", "e3_receipt_event_id", "chain_hash", "provenance_hash", "input_hash", "output_hash"]) {
    assert(sha256Pattern.test(chain[field]), `manifest knowledge chain field missing or invalid: ${field}`);
  }
  assert(Array.isArray(chain.attempt_event_ids) && chain.attempt_event_ids.length >= 1 && chain.attempt_event_ids.every((id) => sha256Pattern.test(id)), "manifest attempt ids invalid");
  const genesis = manifest.constraint;
  for (const field of [
    "genesis_event_id", "projection_event_id", "projection_blob_sha256", "decision_hash",
    "decision_input_root_hash", "decision_validation_hash", "canonical_output_hash",
  ]) assert(sha256Pattern.test(genesis[field]), `manifest constraint field missing or invalid: ${field}`);
  assert(genesis.source_l2.byte_equal === true && genesis.source_l2.committed_sha256 === genesis.source_l2.rerendered_sha256, "manifest L2 byte equality proof invalid");
  assert(genesis.historical_llm_rerun === false, "manifest claims an LLM rerun");
  assert(manifest.scope.claim === "P1-S4 only", "manifest scope overclaims beyond P1-S4");
  assert(manifest.scope.exclusions.includes("P1-B") && manifest.scope.exclusions.includes("P1-A"), "manifest scope does not exclude P1-B/P1-A");
  assert(!/P1-B[^.]*pass/i.test(manifest.scope.counting_rule), "manifest claims P1-B passed");
});

await check("dossier CLI uses temp-only shadow and exits zero only on all-false impact flags", async () => {
  const home = temp("cli-shadow");
  const run = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts/dossier-canonical-path-shadow.mjs"),
    "--source", source.root,
    "--shadow-home", home,
    "--run-id", "cli-dossier",
    "--knowledge-event-id", source.knowledge.event_id,
    "--projection-event-id", source.projection.event_id,
    "--read-config", source.readConfigPath,
    "--keep",
  ], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  assert(run.status === 0, run.stderr || run.stdout);
  for (const field of ["sourceChanged", "refChanged", "indexChanged", "worktreeChanged", "pushChanged", "canonicalChanged", "readChanged", "foldChanged"]) {
    assert(run.stdout.includes(`${field}=false`), `CLI missing ${field}=false:\n${run.stdout}`);
  }
  assert(fs.existsSync(path.join(home, "l2", "shadow", "r3", "knowledge", "cli-dossier", "dossier.json")), "CLI dossier not retained in run root");
});

for (const dir of cleanup.reverse()) fs.rmSync(dir, { recursive: true, force: true });
console.log();
if (failures.length) {
  console.log(`FAIL - ${failures.length}/${passed + failures.length} canonical shadow check(s) failed.`);
  process.exit(1);
}
console.log(`PASS - ${passed} canonical shadow check(s) passed.`);
process.exit(0);
