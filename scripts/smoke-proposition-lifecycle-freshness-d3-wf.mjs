#!/usr/bin/env node
/** ADR0040 D3-WF sandbox writer/control/reader smoke. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runPropositionLifecycleFreshnessD3WfPreview } from "./preview-proposition-lifecycle-freshness-d3-wf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-sandbox-writer.ts"));
const control = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-control-v2.ts"));
const v3 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-v3.ts"));
const proposition = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const lockModule = jiti(path.join(repoRoot, "extensions/_shared/retained-directory-ofd-lock.ts"));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-d3-wf-smoke-"));
let passed = 0;
const failures = [];
let preview;
let base;

function assert(value, message) { if (!value) throw new Error(message || "assertion failed"); }
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error?.stack || error}`); }
}
async function expectBlocked(fn, accepted = null) {
  try { await fn(); throw new Error("expected operation to block"); }
  catch (error) {
    if (error?.message === "expected operation to block") throw error;
    if (accepted && !accepted.includes(error?.code)) throw new Error(`unexpected error code ${error?.code}: ${error?.message}`);
    return error;
  }
}
function eventPath(home, eventId) { return path.join(home, ...l1.expectedL1EventRelativePath(eventId).split("/")); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalJson(value) { return `${canonicalizeJcs(value)}\n`; }
function cloneRoot(label, source = base.root) { const target = path.join(tmpRoot, label); fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true }); return instance(target); }
function instance(root) { return { root, home: path.join(root, "abrain-copy"), control: path.join(root, "proposition-lifecycle-freshness-v3") }; }
function transactionOptions(value, overrides = {}) {
  return {
    sandboxRoot: value.root,
    sandboxAbrainHome: value.home,
    repoRoot,
    sourceProductionSnapshot: base.snapshot,
    tuple: overrides.tuple ?? base.tuple.tuple,
    canonicalEventJson: overrides.raw ?? base.tuple.canonical_event_json,
    expectedPredecessor: overrides.expectedPredecessor ?? { head_hash: base.init.head_hash, selection_hash: base.init.selection_hash },
    ...(overrides.crashAfter ? { crashAfter: overrides.crashAfter } : {}),
    ...(overrides.crashMode ? { crashMode: overrides.crashMode } : {}),
  };
}
function writeMode600(file, raw) { fs.writeFileSync(file, raw); fs.chmodSync(file, 0o600); }
function transactionIdFromCrash(error) { return error?.detail?.transaction_id; }
function tempPath(value, transactionId, tuple = base.tuple) { const final = eventPath(value.home, tuple.event_id); return path.join(path.dirname(final), `.${tuple.event_id}.json.${transactionId.slice(0, 24)}.tmp`); }
function stagePath(value, transactionId) { return path.join(value.control, "stages", "v1", `${transactionId}.json`); }
function predictionPath(value, transactionId = plannedStage().transaction_id) { return path.join(value.root, `.prediction-${transactionId}`); }
function proofPathFromCurrentHead(value) { const hp = control.readHeadPointerRaw(value.control); const head = control.readLifecycleHead(value.control, hp.hash); return path.join(value.control, "proofs", "v1", `${head.transaction.proof_hash}.json`); }
function assertCommittedRelative(result) {
  assert(result.reader.ok && result.reader.source_counts.input_events === base.init.reader.source_counts.input_events + 1);
  assert(result.reader.source_counts.lifecycle_events === base.init.reader.source_counts.lifecycle_events + 1);
  assert(result.reader.source_counts.candidates === base.init.reader.source_counts.candidates - 1);
  assert(result.reader.item_count === base.init.reader.item_count - 1);
}
function replaceMode600(file, raw) { const temporary = `${file}.replace`; writeMode600(temporary, raw); fs.renameSync(temporary, file); }
function protectedControlAndL1(value) { return writer.captureNoFollowProtectedSnapshot([value.control, path.join(value.home, "l1")]); }
function plannedStage(value = base) {
  const predecessor = { head_hash: value.init.head_hash, selection_hash: value.init.selection_hash, generation: value.init.reader.generation, selection_seq: value.init.reader.selection_seq };
  const transactionId = control.transactionIdForLifecycle({ tuple: value.tuple.tuple, staged_event: { event_id: value.tuple.event_id, canonical_event_bytes_sha256: value.tuple.canonical_event_bytes_sha256 }, unique_predecessor: predecessor, source_production_snapshot_hash: value.snapshot.snapshot_hash });
  return control.buildLifecycleStage({ transactionId, tupleHash: control.tupleHashForLifecycle(value.tuple.tuple), eventId: value.tuple.event_id, canonicalEventJson: value.tuple.canonical_event_json });
}
function malformedCall(mutator, preserveBodyHash = false) {
  const envelope = cloneJson(base.tuple.envelope); mutator(envelope);
  if (!preserveBodyHash) { const bodyHash = sha256Hex(canonicalizeJcs(envelope.body)); envelope.event_id = bodyHash; envelope.body_hash = bodyHash; }
  const raw = canonicalJson(envelope); const tuple = cloneJson(base.tuple.tuple); tuple.event_id = envelope.event_id; tuple.body_hash = envelope.body_hash; tuple.relative_target_path = l1.expectedL1EventRelativePath(envelope.event_id); tuple.canonical_event_bytes_sha256 = sha256Hex(raw); tuple.canonical_event_utf8_bytes = Buffer.byteLength(raw);
  return { raw, tuple, eventId: envelope.event_id };
}

async function makeCompactRealBaseline() {
  const root = path.join(tmpRoot, "compact-base"); const home = path.join(root, "abrain-copy"); fs.mkdirSync(home, { recursive: true });
  const rows = [];
  for (const eventId of preview.copied_proposition_prestate.input_event_ids) {
    const relative = l1.expectedL1EventRelativePath(eventId); const source = path.join("/home/worker/.abrain", ...relative.split("/")); const target = path.join(home, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); fs.chmodSync(target, 0o600);
    const raw = fs.readFileSync(target); rows.push({ event_id: eventId, relative_path: relative, bytes: raw.length, raw_sha256: crypto.createHash("sha256").update(raw).digest("hex") });
  }
  const snapshot = v3.buildLifecycleSourceSnapshot({ sourceKind: "production_double_scan_copy", rows });
  assert(snapshot.snapshot_hash === preview.copied_proposition_prestate.snapshot_hash, "dynamic compact source differs from preview production snapshot");
  const init = await writer.initializeLifecycleSandboxWorkflow({ sandboxRoot: root, sandboxAbrainHome: home, repoRoot, sourceProductionSnapshot: snapshot });
  const tuple = await writer.prepareSandboxArchiveTuple({ sandboxAbrainHome: home, repoRoot });
  return { root, home, control: path.join(root, "proposition-lifecycle-freshness-v3"), snapshot, init, tuple };
}

function divergentTuple() {
  const envelope = cloneJson(base.tuple.envelope);
  envelope.body.lifecycle.reason = `${envelope.body.lifecycle.reason} Divergent writer candidate.`;
  const rebuilt = proposition.buildPropositionEnvelope(proposition.PROPOSITION_LIFECYCLE_ENVELOPE_SCHEMA, envelope.body);
  const raw = l1.canonicalL1EnvelopeJson(rebuilt);
  const tuple = cloneJson(base.tuple.tuple);
  tuple.event_id = rebuilt.event_id; tuple.body_hash = rebuilt.body_hash; tuple.relative_target_path = l1.expectedL1EventRelativePath(rebuilt.event_id); tuple.canonical_event_bytes_sha256 = sha256Hex(raw); tuple.canonical_event_utf8_bytes = Buffer.byteLength(raw);
  return { tuple, raw, event_id: rebuilt.event_id };
}

async function crashState(label, crashAfter) {
  const value = cloneRoot(label); let crash;
  try { await writer.executeLifecycleSandboxTransaction(transactionOptions(value, { crashAfter })); }
  catch (error) { crash = error; }
  assert(crash?.code === "INJECTED_CRASH" && crash.detail?.point === crashAfter, `${crashAfter} did not inject exact crash`);
  return { value, transactionId: transactionIdFromCrash(crash) };
}

async function hardPredictionCrash(label, crashAfter) {
  const value = cloneRoot(label);
  const options = transactionOptions(value, { crashAfter, crashMode: "SIGKILL" });
  const code = `const path=require('node:path');const {createRequire}=require('node:module');const root=process.env.D3_REPO_ROOT;const req=createRequire(path.join(root,'package.json'));const {createJiti}=req('jiti');const writer=createJiti(root,{interopDefault:true})(path.join(root,'extensions/_shared/proposition-lifecycle-freshness-sandbox-writer.ts'));writer.executeLifecycleSandboxTransaction(JSON.parse(process.env.D3_TRANSACTION)).then(()=>process.exit(70),e=>{console.error(e&&e.stack||e);process.exit(71)});`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, D3_REPO_ROOT: repoRoot, D3_TRANSACTION: JSON.stringify(options) }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exit = await new Promise((resolve) => child.once("exit", (codeValue, signal) => resolve({ code: codeValue, signal })));
  assert(exit.signal === "SIGKILL", `${crashAfter} child did not hard-exit with SIGKILL: ${JSON.stringify(exit)} ${stderr}`);
  return value;
}

console.log("ADR0040 D3-WF sandbox staged append/replay smoke");
try {
  await check("real production full L1 byte-copy/replay succeeds with protected surfaces unchanged", async () => {
    preview = await runPropositionLifecycleFreshnessD3WfPreview();
    assert(preview.production_source.before_after_equal && preview.production_source.workflow_after_equals_copy_bracket_after && preview.production_source.all_event_ids_and_raw_hashes_equal && preview.production_source.no_hardlinks_to_production);
    assert(preview.copied_proposition_prestate.input_event_count === preview.baseline.source_counts.input_events);
    assert(preview.committed.relative_changes.input_events_delta === 1 && preview.committed.relative_changes.lifecycle_events_delta === 1);
    assert(preview.committed.relative_changes.candidates_delta === -1 && preview.committed.relative_changes.stable_items_delta === -1 && preview.committed.relative_changes.target_candidate_removed);
    assert(!preview.committed.active_candidate_event_ids.includes(preview.archive_tuple.target_real_active_evidence_event_id));
    assert(preview.production_nonmutation.equal && preview.production_nonmutation.production_l1_copy_bracket_equal && preview.production_nonmutation.production_l1_workflow_after_equal && !preview.production_nonmutation.observed_production_mutation);
  });

  base = await makeCompactRealBaseline();
  await check("compact baseline is dynamically copied from the real proposition prestate", () => {
    assert(base.init.reader.ok && base.init.reader.item_count === preview.baseline.item_count);
    assert(base.init.reader.source_counts.input_events === preview.copied_proposition_prestate.input_event_count);
    assert(base.init.reader.source_counts.candidates === preview.baseline.source_counts.candidates);
    assert(base.tuple.target_event_id === preview.archive_tuple.target_real_active_evidence_event_id);
  });
  await check("archive tuple uses registered schema-contract producer and validates through scanner", async () => {
    assert(base.tuple.tuple.producer.name === proposition.PROPOSITION_SCHEMA_CONTRACT_PRODUCER);
    const scan = await l1.scanWholeL1Validated({ abrainHome: base.home });
    assert(scan.definedInactiveShadow.filter((row) => row.registration.domain === "proposition").length === base.snapshot.input_event_count);
  });

  await check("whole-L1 snapshot v2 directly binds each row's raw SHA-256 into rows and snapshot hashes", async () => {
    const snapshot = await writer.captureWholeL1RawSnapshot(base.home);
    assert(snapshot.schema_version === "proposition-lifecycle-whole-l1-raw-snapshot/v2" && snapshot.raw_sha256s_hash && snapshot.rows_hash_scope.includes("raw-sha256") && snapshot.snapshot_hash_scope.includes("raw-sha256"));
    assert(writer.validateWholeL1RawSnapshot(snapshot).snapshot_hash === snapshot.snapshot_hash);
  });

  await check("raw-byte substitution and legacy weak-hash recomputation are rejected without an external snapshot comparison", async () => {
    const captured = await writer.captureWholeL1RawSnapshot(base.home);
    const rawOnly = cloneJson(captured); rawOnly.rows[0].raw += " ";
    await expectBlocked(() => writer.validateWholeL1RawSnapshot(rawOnly), ["WHOLE_L1_RAW_BINDING_INVALID"]);
    const weak = cloneJson(captured); weak.rows[0].raw += " "; weak.rows[0].bytes = Buffer.byteLength(weak.rows[0].raw); weak.rows[0].raw_sha256 = sha256Hex(weak.rows[0].raw);
    weak.raw_sha256s_hash = jcsSha256Hex(weak.rows.map((row) => ({ event_id: row.event_id, raw_sha256: row.raw_sha256 })));
    const weakRows = weak.rows.map(({ raw: _raw, raw_sha256: _rawSha256, ...metadata }) => metadata);
    weak.rows_hash = jcsSha256Hex(weakRows); weak.snapshot_hash = jcsSha256Hex({ event_count: weak.event_count, event_ids_hash: weak.event_ids_hash, rows_hash: weak.rows_hash });
    await expectBlocked(() => writer.validateWholeL1RawSnapshot(weak), ["WHOLE_L1_HASH_BINDING_INVALID"]);
  });

  for (const crashAfter of ["S0", "S1", "intent_cas", "intent_head", "S2", "S3", "S4", "artifacts", "proof", "committed_head"]) {
    await check(`${crashAfter} crash converges on next same-transaction invocation`, async () => {
      const { value } = await crashState(`crash-${crashAfter}`, crashAfter);
      const intermediate = control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control });
      if (["intent_head", "S2", "S3", "S4", "artifacts", "proof", "committed_head"].includes(crashAfter)) assert(intermediate.ok && intermediate.status === "fallback", `${crashAfter} reader must use old selection fallback`);
      else assert(intermediate.ok && intermediate.status === "active", `${crashAfter} reader must remain on baseline`);
      const recovered = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
      assert(recovered.status === "committed" && recovered.reader.ok);
      assertCommittedRelative(recovered);
    });
  }

  for (const crashAfter of ["prediction_directory_created", "prediction_partially_copied", "prediction_built_before_intent"]) {
    await check(`${crashAfter} SIGKILL residue is exactly cleaned and rebuilt by the next same tuple`, async () => {
      const value = await hardPredictionCrash(`hard-${crashAfter}`, crashAfter); const residue = predictionPath(value);
      assert(fs.lstatSync(residue).isDirectory(), `${crashAfter} did not leave a prediction directory`);
      const recovered = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
      assert(recovered.status === "committed" && recovered.reader.ok && !fs.existsSync(residue)); assertCommittedRelative(recovered);
    });
  }

  await check("same-transaction prediction symlink and foreign directory shape block without deletion", async () => {
    const symlinked = cloneRoot("prediction-symlink"); const symlinkPath = predictionPath(symlinked); fs.symlinkSync("/dev/null", symlinkPath);
    await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(symlinked)), ["PREDICTION_RESIDUE_UNSAFE"]); assert(fs.lstatSync(symlinkPath).isSymbolicLink());
    const shaped = cloneRoot("prediction-shape"); const shapedPath = predictionPath(shaped); fs.mkdirSync(shapedPath); writeMode600(path.join(shapedPath, "foreign"), "x");
    await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(shaped)), ["PREDICTION_RESIDUE_SHAPE_INVALID"]); assert(fs.existsSync(path.join(shapedPath, "foreign")));
  });

  await check("recovery never bulk-deletes different or foreign prediction directories", async () => {
    const value = cloneRoot("prediction-foreign-preserved"); const own = predictionPath(value); fs.mkdirSync(own);
    const foreignDirectory = path.join(value.root, `.prediction-${"e".repeat(64)}`); const foreignSymlink = path.join(value.root, `.prediction-${"d".repeat(64)}`); fs.mkdirSync(foreignDirectory); writeMode600(path.join(foreignDirectory, "sentinel"), "keep"); fs.symlinkSync("/dev/null", foreignSymlink);
    const recovered = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
    assert(recovered.status === "committed" && !fs.existsSync(own) && fs.readFileSync(path.join(foreignDirectory, "sentinel"), "utf8") === "keep" && fs.lstatSync(foreignSymlink).isSymbolicLink());
  });

  await check("same transaction is idempotent with identical head/selection/proof", async () => {
    const value = cloneRoot("idempotent"); const first = await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); const second = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
    assert(first.status === "committed" && second.status === "identical");
    for (const field of ["transaction_id", "proof_hash", "committed_head_hash", "selection_hash"]) assert(first[field] === second[field], `${field} changed`);
  });

  await check("CAS link-before-unlink crash leaves nlink-2 and next same tuple converges", async () => {
    const value = cloneRoot("cas-link-crash"); const stage = plannedStage(); const relative = `stages/v1/${stage.transaction_id}.json`; const raw = control.canonicalControlJson(stage); const target = path.join(value.control, ...relative.split("/")); const temporary = `${target}.cas-${sha256Hex(raw).slice(0, 24)}.tmp`;
    let crashed = false;
    try { control.__TEST.durableCasCreate(value.control, relative, raw, { afterLinkBeforeUnlink() { throw new Error("CAS_LINK_CRASH"); } }); }
    catch (error) { crashed = error?.message === "CAS_LINK_CRASH"; }
    assert(crashed && fs.existsSync(target) && fs.existsSync(temporary));
    const left = fs.lstatSync(target); const right = fs.lstatSync(temporary); assert(left.dev === right.dev && left.ino === right.ino && left.nlink === 2 && right.nlink === 2);
    const recovered = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
    assert(recovered.status === "committed" && !fs.existsSync(temporary) && fs.lstatSync(target).nlink === 1); assertCommittedRelative(recovered);
  });

  await check("CAS different-inode, different-bytes, and foreign deterministic temps block", async () => {
    const stage = plannedStage(); const raw = control.canonicalControlJson(stage); const relative = `stages/v1/${stage.transaction_id}.json`;
    for (const kind of ["different-inode", "different-bytes", "foreign-temp"]) {
      const value = cloneRoot(`cas-${kind}`); const target = path.join(value.control, ...relative.split("/")); const temporary = `${target}.cas-${sha256Hex(raw).slice(0, 24)}.tmp`; fs.mkdirSync(path.dirname(target), { recursive: true });
      if (kind === "different-inode") { writeMode600(target, raw); writeMode600(temporary, raw); }
      if (kind === "different-bytes") writeMode600(temporary, "{}\n");
      if (kind === "foreign-temp") writeMode600(`${target}.cas-foreign.tmp`, raw);
      await expectBlocked(() => control.__TEST.durableCasCreate(value.control, relative, raw));
    }
  });

  await check("pointer prepare crash reuses exact residue and rename-time reread preserves a foreign successor", async () => {
    const recovered = cloneRoot("pointer-prepare-crash"); const expected = control.readHeadPointerRaw(recovered.control); const nextHash = sha256Hex("pointer-next"); const nextRaw = canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA, head_hash: nextHash }); const temporary = path.join(recovered.control, "heads", `.current.${sha256Hex(nextRaw).slice(0, 24)}.tmp`);
    let crashed = false;
    try { control.advanceLifecyclePointer(recovered.control, "head", expected.raw, nextHash, { afterPrepareBeforeSecondRead() { throw new Error("POINTER_PREPARE_CRASH"); } }); }
    catch (error) { crashed = error?.message === "POINTER_PREPARE_CRASH"; }
    assert(crashed && fs.existsSync(temporary)); assert(control.advanceLifecyclePointer(recovered.control, "head", expected.raw, nextHash)); assert(!fs.existsSync(temporary));

    const raced = cloneRoot("pointer-reread-race"); const racedExpected = control.readHeadPointerRaw(raced.control); const candidateHash = sha256Hex("pointer-candidate"); const foreignHash = sha256Hex("pointer-foreign"); const pointerFile = path.join(raced.control, "heads", "current.json");
    const error = await expectBlocked(() => control.advanceLifecyclePointer(raced.control, "head", racedExpected.raw, candidateHash, { afterPrepareBeforeSecondRead() { replaceMode600(pointerFile, canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA, head_hash: foreignHash })); } }), ["POINTER_PREDECESSOR_MISMATCH"]);
    assert(error.code === "POINTER_PREDECESSOR_MISMATCH" && control.readHeadPointerRaw(raced.control).hash === foreignHash);
  });

  await check("foreign pointer temp is blocked, including when target already has next value", async () => {
    const value = cloneRoot("pointer-foreign-temp"); const expected = control.readSelectionPointerRaw(value.control); const nextHash = sha256Hex("selection-next"); writeMode600(path.join(value.control, "selections", ".current.foreign.tmp"), "{}\n");
    await expectBlocked(() => control.advanceLifecyclePointer(value.control, "selection", expected.raw, nextHash), ["FOREIGN_TEMP_BLOCKED"]);
  });

  await check("bootstrap head-pointer-only crash validates genesis artifacts and restores exact selection", async () => {
    const root = path.join(tmpRoot, "bootstrap-head-only"); const home = path.join(root, "abrain-copy"); fs.mkdirSync(root, { recursive: true }); fs.cpSync(base.home, home, { recursive: true, dereference: false }); let crash;
    try { await writer.initializeLifecycleSandboxWorkflow({ sandboxRoot: root, sandboxAbrainHome: home, repoRoot, sourceProductionSnapshot: base.snapshot, crashAfter: "head_pointer" }); }
    catch (error) { crash = error; }
    const value = instance(root); assert(crash?.code === "INJECTED_BOOTSTRAP_CRASH" && control.readHeadPointerRaw(value.control) && !control.readSelectionPointerRaw(value.control));
    const recovered = await writer.initializeLifecycleSandboxWorkflow({ sandboxRoot: root, sandboxAbrainHome: home, repoRoot, sourceProductionSnapshot: base.snapshot });
    assert(recovered.status === "created" && recovered.reader.ok && recovered.reader.status === "active" && recovered.selection_hash === crash.detail.selection_hash);

    const inverse = cloneRoot("bootstrap-selection-only"); fs.unlinkSync(path.join(inverse.control, "heads", "current.json"));
    await expectBlocked(() => writer.initializeLifecycleSandboxWorkflow({ sandboxRoot: inverse.root, sandboxAbrainHome: inverse.home, repoRoot, sourceProductionSnapshot: base.snapshot }), ["BOOTSTRAP_PARTIAL_POINTERS"]);
  });

  await check("CAS readers reject self-consistent legal genesis and successor objects under wrong hash filenames", async () => {
    const value = cloneRoot("cas-filename-identity"); const committed = await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); const headPointer = control.readHeadPointerRaw(value.control); const selectionPointer = control.readSelectionPointerRaw(value.control); const successorHead = control.readLifecycleHead(value.control, headPointer.hash); const successorSelection = control.readLifecycleSelection(value.control, selectionPointer.hash);
    const transaction = successorHead.transaction; const cases = [
      { family: "heads/v2", object: control.readLifecycleHead(value.control, base.init.head_hash), read: (hash) => control.readLifecycleHead(value.control, hash) },
      { family: "selections/v2", object: control.readLifecycleSelection(value.control, base.init.selection_hash), read: (hash) => control.readLifecycleSelection(value.control, hash) },
      { family: "heads/v2", object: successorHead, read: (hash) => control.readLifecycleHead(value.control, hash) },
      { family: "intents/v2", object: control.readLifecycleIntent(value.control, transaction.intent_hash), read: (hash) => control.readLifecycleIntent(value.control, hash) },
      { family: "proofs/v1", object: control.readLifecycleProof(value.control, transaction.proof_hash), read: (hash) => control.readLifecycleProof(value.control, hash) },
      { family: "selections/v2", object: successorSelection, read: (hash) => control.readLifecycleSelection(value.control, hash) },
    ];
    for (const [index, attack] of cases.entries()) { const wrong = sha256Hex(`wrong-cas-name-${index}`); writeMode600(path.join(value.control, ...attack.family.split("/"), `${wrong}.json`), canonicalJson(attack.object)); await expectBlocked(() => attack.read(wrong), ["CAS_IDENTITY_MISMATCH"]); }
    assert(committed.status === "committed");
  });

  await check("head and selection chain backtracking reject wrong-filename genesis objects", async () => {
    const headAttack = cloneRoot("head-chain-filename"); await writer.executeLifecycleSandboxTransaction(transactionOptions(headAttack)); const currentHeadPointer = control.readHeadPointerRaw(headAttack.control); const currentSelectionPointer = control.readSelectionPointerRaw(headAttack.control); const currentHead = cloneJson(control.readLifecycleHead(headAttack.control, currentHeadPointer.hash)); const currentSelection = cloneJson(control.readLifecycleSelection(headAttack.control, currentSelectionPointer.hash)); const wrongGenesisHead = sha256Hex("wrong-genesis-head-file");
    writeMode600(path.join(headAttack.control, "heads", "v2", `${wrongGenesisHead}.json`), canonicalJson(control.readLifecycleHead(headAttack.control, base.init.head_hash)));
    currentHead.predecessor_head_hash = wrongGenesisHead; currentHead.head_hash = control.__TEST.identityHash(currentHead, "head_hash"); writeMode600(path.join(headAttack.control, "heads", "v2", `${currentHead.head_hash}.json`), canonicalJson(currentHead)); currentSelection.committed_head_hash = currentHead.head_hash; currentSelection.selection_hash = control.__TEST.identityHash(currentSelection, "selection_hash"); writeMode600(path.join(headAttack.control, "selections", "v2", `${currentSelection.selection_hash}.json`), canonicalJson(currentSelection)); replaceMode600(path.join(headAttack.control, "heads", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA, head_hash: currentHead.head_hash })); replaceMode600(path.join(headAttack.control, "selections", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA, selection_hash: currentSelection.selection_hash })); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: headAttack.control }).ok);

    const selectionAttack = cloneRoot("selection-chain-filename"); await writer.executeLifecycleSandboxTransaction(transactionOptions(selectionAttack)); const selectionPointer = control.readSelectionPointerRaw(selectionAttack.control); const selection = cloneJson(control.readLifecycleSelection(selectionAttack.control, selectionPointer.hash)); const wrongGenesisSelection = sha256Hex("wrong-genesis-selection-file"); writeMode600(path.join(selectionAttack.control, "selections", "v2", `${wrongGenesisSelection}.json`), canonicalJson(control.readLifecycleSelection(selectionAttack.control, base.init.selection_hash))); selection.predecessor_selection_hash = wrongGenesisSelection; selection.selection_hash = control.__TEST.identityHash(selection, "selection_hash"); writeMode600(path.join(selectionAttack.control, "selections", "v2", `${selection.selection_hash}.json`), canonicalJson(selection)); replaceMode600(path.join(selectionAttack.control, "selections", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA, selection_hash: selection.selection_hash })); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: selectionAttack.control }).ok);
  });

  await check("self-consistent proof/head/selection rehash cannot falsify measured append bytes", async () => {
    const value = cloneRoot("proof-rehash-attack"); await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); const headPointer = control.readHeadPointerRaw(value.control); const selectionPointer = control.readSelectionPointerRaw(value.control); const head = cloneJson(control.readLifecycleHead(value.control, headPointer.hash)); const selection = cloneJson(control.readLifecycleSelection(value.control, selectionPointer.hash)); const proof = cloneJson(control.readLifecycleProof(value.control, head.transaction.proof_hash));
    proof.final_append.bytes += 1; proof.checkpoints.Cpost.final_append.bytes += 1; proof.post_scan.append_row.bytes += 1; proof.checkpoints.checkpoint_hashes.Cpost = control.__TEST.identityHash({ ...proof.checkpoints.Cpost, checkpoint_hash: "0".repeat(64) }, "checkpoint_hash", false); proof.proof_hash = control.__TEST.identityHash(proof, "proof_hash");
    control.writeLifecycleProofCas(value.control, proof); head.transaction.proof_hash = proof.proof_hash; head.artifacts.proof_hash = proof.proof_hash; head.head_hash = control.__TEST.identityHash(head, "head_hash"); control.writeLifecycleHeadCas(value.control, head); selection.committed_head_hash = head.head_hash; selection.proof_hash = proof.proof_hash; selection.references.proof_hash = proof.proof_hash; selection.selection_hash = control.__TEST.identityHash(selection, "selection_hash"); control.writeLifecycleSelectionCas(value.control, selection); replaceMode600(path.join(value.control, "heads", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA, head_hash: head.head_hash })); replaceMode600(path.join(value.control, "selections", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA, selection_hash: selection.selection_hash }));
    const result = control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control }); assert(!result.ok && result.reason === "PROOF_APPEND_STAGE_MISMATCH", `unexpected proof attack result ${result.reason}`);
  });

  await check("v3 direct build rejects same event IDs with changed raw envelope bytes", async () => {
    const value = cloneRoot("v3-raw-source-mismatch"); const row = base.snapshot.rows[0]; fs.appendFileSync(path.join(value.home, ...row.relative_path.split("/")), "\n");
    await expectBlocked(() => v3.buildPropositionLifecycleV3Artifacts({ sandboxAbrainHome: value.home, repoRoot, sourceSnapshot: base.snapshot, stagedEvent: null }), ["V3_SOURCE_MISMATCH"]);
  });

  await check("malformed body hash, producer, schema, and lineage never create stage or L1 event", async () => {
    const attacks = [
      malformedCall((envelope) => { envelope.body.lifecycle.reason += " tampered"; }, true),
      malformedCall((envelope) => { envelope.body.producer.name = "foreign.producer"; }),
      malformedCall((envelope) => { envelope.body.event_schema_version = "proposition-lifecycle-event/v999"; }),
      malformedCall((envelope) => { envelope.body.facets.lineage.causal_parents = ["not-a-sha256"]; }),
    ];
    for (const [index, attack] of attacks.entries()) { const value = cloneRoot(`malformed-${index}`); const before = protectedControlAndL1(value); await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value, { tuple: attack.tuple, raw: attack.raw }))); const after = protectedControlAndL1(value); assert(canonicalizeJcs(before) === canonicalizeJcs(after) && !fs.existsSync(eventPath(value.home, attack.eventId))); }
  });

  await check("v2 reader serves selected artifacts after sandbox L1 deletion without compiling", async () => {
    const value = cloneRoot("reader-no-l1"); const committed = await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); fs.rmSync(path.join(value.home, "l1"), { recursive: true, force: true }); const read = control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control }); assert(read.ok && read.selection_hash === committed.selection_hash && read.stable_bundle_hash === committed.reader.stable_bundle_hash);
  });

  await check("head and selection pointer double-read races are independently detected", () => {
    for (const kind of ["head", "selection"]) { const value = cloneRoot(`double-read-${kind}`); const file = path.join(value.control, kind === "head" ? "heads" : "selections", "current.json"); const raw = fs.readFileSync(file, "utf8"); const result = control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control, afterFirstPointerReads() { replaceMode600(file, raw); } }); assert(!result.ok && result.reason === `${kind}_pointer_changed`); }
  });

  await check("same-filesystem checks execute and explicit cross-device roots block", async () => {
    assert(fs.lstatSync(base.control).dev === fs.lstatSync(base.home).dev);
    if (fs.existsSync("/dev/shm") && fs.lstatSync("/dev/shm").dev !== fs.lstatSync(base.control).dev) await expectBlocked(() => writer.__TEST.assertSameFilesystem(base.control, "/dev/shm"), ["SANDBOX_FILESYSTEM_EXDEV"]);
    const value = cloneRoot("same-filesystem-transaction"); const committed = await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); const stage = plannedStage(); assert(fs.lstatSync(value.control).dev === fs.lstatSync(stagePath(value, stage.transaction_id)).dev && fs.lstatSync(value.control).dev === fs.lstatSync(eventPath(value.home, base.tuple.event_id)).dev && committed.status === "committed");
  });

  await check("BUSY contender leaves the complete control and L1 protected snapshot unchanged", async () => {
    const value = cloneRoot("busy"); const held = lockModule.acquireRetainedDirectoryOfdLock(value.control); assert(held.status === "ACQUIRED");
    const before = protectedControlAndL1(value);
    try { const result = await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); assert(result.status === "BUSY"); }
    finally { held.close(); }
    const after = protectedControlAndL1(value);
    assert(canonicalizeJcs(before) === canonicalizeJcs(after));
  });

  await check("parent close releases retained OFD lock and creates no lock file", () => {
    const held = lockModule.acquireRetainedDirectoryOfdLock(base.control); assert(held.status === "ACQUIRED");
    const busy = lockModule.acquireRetainedDirectoryOfdLock(base.control); assert(busy.status === "BUSY"); held.close();
    const released = lockModule.acquireRetainedDirectoryOfdLock(base.control); assert(released.status === "ACQUIRED"); released.close();
    assert(!fs.readdirSync(base.control).some((name) => /lock/i.test(name)));
  });

  await check("SIGKILL holder releases retained OFD lock", async () => {
    const code = `const fs=require('node:fs'),cp=require('node:child_process');const d=process.argv[1];const fd=fs.openSync(d,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const r=cp.spawnSync('/usr/bin/flock',['-xn','3'],{stdio:['ignore','ignore','ignore',fd]});if(r.status!==0)process.exit(80);process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", code, base.control], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => { child.stdout.once("data", (data) => String(data).includes("READY") ? resolve() : reject(new Error("holder not ready"))); child.once("exit", (codeValue) => reject(new Error(`holder exited ${codeValue}`))); });
    const busy = lockModule.acquireRetainedDirectoryOfdLock(base.control); assert(busy.status === "BUSY"); child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
    const released = lockModule.acquireRetainedDirectoryOfdLock(base.control); assert(released.status === "ACQUIRED"); released.close();
  });

  await check("two divergent writers cannot lose an update", async () => {
    const value = cloneRoot("divergent"); const alternative = divergentTuple();
    const first = await writer.executeLifecycleSandboxTransaction(transactionOptions(value));
    const error = await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value, { tuple: alternative.tuple, raw: alternative.raw })), ["STALE_PREDECESSOR"]);
    assert(error.code === "STALE_PREDECESSOR"); assert(fs.existsSync(eventPath(value.home, first.event_id))); assert(!fs.existsSync(eventPath(value.home, alternative.event_id)));
  });

  await check("stale predecessor blocks before successor publication", async () => {
    const value = cloneRoot("stale"); await writer.executeLifecycleSandboxTransaction(transactionOptions(value)); const alternative = divergentTuple();
    await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value, { tuple: alternative.tuple, raw: alternative.raw, expectedPredecessor: { head_hash: base.init.head_hash, selection_hash: base.init.selection_hash } })), ["STALE_PREDECESSOR"]);
  });

  await check("foreign v1 head pointer and selection-ahead pointer fail closed", async () => {
    const foreign = cloneRoot("foreign-pointer"); writeMode600(path.join(foreign.control, "heads", "current.json"), canonicalJson({ schema_version: "proposition-lifecycle-freshness-head-pointer/v1", head_hash: base.init.head_hash })); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: foreign.control }).ok);
    const ahead = cloneRoot("selection-ahead"); writeMode600(path.join(ahead.control, "selections", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_V2_SCHEMA, selection_hash: "f".repeat(64) })); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: ahead.control }).ok);
    const fork = cloneRoot("fork-current"); writeMode600(path.join(fork.control, "heads", "current.json"), canonicalJson({ schema_version: control.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_V2_SCHEMA, head_hash: "e".repeat(64) })); await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(fork)));
  });

  await check("proof missing is detected before artifact activation", async () => {
    const state = await crashState("proof-priority", "committed_head"); const proofFile = proofPathFromCurrentHead(state.value); fs.unlinkSync(proofFile);
    const selected = control.readLifecycleSelection(state.value.control, control.readSelectionPointerRaw(state.value.control).hash); fs.rmSync(path.join(state.value.control, "stable", "v3", "bundles", selected.references.stable_bundle_hash), { recursive: true, force: true });
    const result = control.readPropositionLifecycleFreshnessV2({ controlRoot: state.value.control }); assert(!result.ok && !String(result.reason).includes("BUNDLE"), `artifact failure won priority: ${result.reason}`);
  });

  await check("proof mismatch is detected before new selection activation", async () => {
    const state = await crashState("proof-mismatch", "committed_head"); const proofFile = proofPathFromCurrentHead(state.value); const proof = JSON.parse(fs.readFileSync(proofFile, "utf8")); proof.proof_hash = "0".repeat(64); writeMode600(proofFile, canonicalJson(proof));
    const result = control.readPropositionLifecycleFreshnessV2({ controlRoot: state.value.control }); assert(!result.ok);
  });

  await check("sandbox P2a v3 rejects a v2 manifest mixed into manifest.json", () => {
    const value = cloneRoot("p2a-v2-mix"); const selected = control.readLifecycleSelection(value.control, control.readSelectionPointerRaw(value.control).hash); const dir = path.join(value.control, "p2a", "v3", "bundles", selected.references.p2a_bundle_hash); writeMode600(path.join(dir, "manifest.json"), fs.readFileSync(path.join(dir, "source-manifest.v2.json"), "utf8")); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control }).ok);
  });
  await check("sandbox stable v3 rejects a v2 manifest mixed into manifest.json", () => {
    const value = cloneRoot("stable-v2-mix"); const selected = control.readLifecycleSelection(value.control, control.readSelectionPointerRaw(value.control).hash); const dir = path.join(value.control, "stable", "v3", "bundles", selected.references.stable_bundle_hash); writeMode600(path.join(dir, "manifest.json"), fs.readFileSync(path.join(dir, "source-manifest.v2.json"), "utf8")); assert(!control.readPropositionLifecycleFreshnessV2({ controlRoot: value.control }).ok);
  });

  await check("stage collision, symlink, mode, and nlink anomalies block", async () => {
    const staged = await crashState("stage-anomaly-base", "S1"); const file = stagePath(staged.value, staged.transactionId);
    for (const kind of ["collision", "symlink", "mode", "nlink"]) {
      const value = cloneRoot(`stage-${kind}`, staged.value.root); const target = stagePath(value, staged.transactionId);
      if (kind === "collision") writeMode600(target, "{}\n");
      if (kind === "symlink") { fs.unlinkSync(target); fs.symlinkSync("/dev/null", target); }
      if (kind === "mode") fs.chmodSync(target, 0o644);
      if (kind === "nlink") fs.linkSync(target, `${target}.extra`);
      await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value)));
    }
    assert(fs.existsSync(file));
  });

  await check("temp collision, symlink, mode, nlink, and foreign entry anomalies block", async () => {
    const staged = await crashState("temp-anomaly-base", "S2");
    for (const kind of ["collision", "symlink", "mode", "nlink", "foreign"]) {
      const value = cloneRoot(`temp-${kind}`, staged.value.root); const target = tempPath(value, staged.transactionId);
      if (kind === "collision") writeMode600(target, "{}\n");
      if (kind === "symlink") { fs.unlinkSync(target); fs.symlinkSync("/dev/null", target); }
      if (kind === "mode") fs.chmodSync(target, 0o644);
      if (kind === "nlink") fs.linkSync(target, `${target}.extra`);
      if (kind === "foreign") writeMode600(path.join(path.dirname(target), "foreign"), "x");
      await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value)));
    }
  });

  await check("final collision, symlink, mode, and nlink anomalies block", async () => {
    const staged = await crashState("final-anomaly-base", "S4");
    for (const kind of ["collision", "symlink", "mode", "nlink"]) {
      const value = cloneRoot(`final-${kind}`, staged.value.root); const target = eventPath(value.home, base.tuple.event_id);
      if (kind === "collision") writeMode600(target, "{}\n");
      if (kind === "symlink") { fs.unlinkSync(target); fs.symlinkSync("/dev/null", target); }
      if (kind === "mode") fs.chmodSync(target, 0o644);
      if (kind === "nlink") fs.linkSync(target, `${target}.extra`);
      await expectBlocked(() => writer.executeLifecycleSandboxTransaction(transactionOptions(value)));
    }
  });

  await check("production, repo, temp-root, non-temp, and cross-root L1 paths are refused", async () => {
    for (const root of ["/home/worker/.abrain", repoRoot, fs.realpathSync(os.tmpdir()), path.join("/home/worker", "not-system-temp-d3-wf")]) {
      await expectBlocked(() => writer.initializeLifecycleSandboxWorkflow({ sandboxRoot: root, sandboxAbrainHome: base.home, repoRoot, sourceProductionSnapshot: base.snapshot }));
    }
    const confined = cloneRoot("cross-root-home");
    await expectBlocked(() => writer.executeLifecycleSandboxTransaction({ ...transactionOptions(confined), sandboxAbrainHome: "/home/worker/.abrain" }), ["SANDBOX_ABRAIN_PATH_INVALID"]);
  });

  await check("layout v3 has no fallback root/current, lock file, or production path", () => {
    assert(control.PROPOSITION_LIFECYCLE_FRESHNESS_LAYOUT_V3.endsWith("/v3"));
    assert(!fs.existsSync(path.join(base.control, "current.json")));
    assert(!fs.readdirSync(base.control).some((name) => /lock/i.test(name)));
    assert(!base.control.startsWith("/home/worker/.abrain"));
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nADR0040 D3-WF smoke failed: ${failures.length} failure(s), ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nADR0040 D3-WF smoke passed: ${passed} checks`);
  console.log(JSON.stringify({ passed, real_preview: { dossier_hash: preview.dossier_hash, whole_l1_event_count: preview.production_source.whole_l1_event_count, whole_l1_snapshot_hash: preview.production_source.whole_l1_snapshot_hash, proposition_prestate_count: preview.copied_proposition_prestate.input_event_count, lifecycle_event_id: preview.archive_tuple.lifecycle_event_id, transaction_id: preview.committed.transaction_id, proof_hash: preview.committed.proof_hash, p2a_v3_bundle_hash: preview.committed.p2a_bundle_hash, stable_v3_bundle_hash: preview.committed.stable_bundle_hash, production_protected_snapshot_hash: preview.production_nonmutation.before_snapshot_hash } }, null, 2));
}
