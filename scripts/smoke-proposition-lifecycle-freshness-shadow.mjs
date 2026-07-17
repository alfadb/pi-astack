#!/usr/bin/env node
/** ADR0040 lifecycle-aware freshness D3 dual-pointer shadow control-plane smoke. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runPropositionLifecycleFreshnessPreview } from "./preview-proposition-lifecycle-freshness-shadow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const freshness = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-shadow.ts"));
const sourceProduction = "/home/worker/.abrain";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-adr0040-freshness-d3-"));
const sourceA = path.join(tmpRoot, "source-a");
const sourceB = path.join(tmpRoot, "source-b");
const outputA = path.join(tmpRoot, "output-a");
const previewRuntimeConfig = path.join(tmpRoot, "pi-astack-settings.json");
const genesisId = "3975b8c76dbad212ff73aa07a232b72196ffd6ba3f355ae77701813c0d4b27d3";
const policyId = "1c8cc5d23110f44affb574598e65027ac350373b86c651c4ed1354ad171685a6";
const excludedId = "beee43be3ca23c25c77981349cb378a91948d84f6ca92cc5777d066514651585";
let buildA;
let buildA2;
let buildB;
let blockedBuild;
let productionCommitted;
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
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error?.message || error}`);
  }
}

function eventPath(home, eventId) {
  return path.join(home, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}

function copyEvents(home, eventIds) {
  fs.mkdirSync(home, { recursive: true });
  for (const eventId of eventIds) {
    const target = eventPath(home, eventId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(eventPath(sourceProduction, eventId), target);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return freshness.__TEST.canonicalJson(value);
}

function rehash(record, field) {
  const copy = clone(record);
  delete copy[field];
  copy[field] = freshness.__TEST.identityHash(copy);
  return copy;
}

function cloneOutput(label, source = outputA) {
  const target = path.join(tmpRoot, label);
  fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  return target;
}

function writeCasRecord(root, family, identity, name, record) {
  const directory = path.join(root, family, "v1", identity);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), canonicalJson(record), "utf8");
}

function setHeadPointer(root, headHash) {
  fs.writeFileSync(path.join(root, "heads", "current.json"), canonicalJson({
    schema_version: freshness.PROPOSITION_LIFECYCLE_FRESHNESS_HEAD_POINTER_SCHEMA,
    head_hash: headHash,
  }), "utf8");
}

function setSelectionPointer(root, selectionHash) {
  fs.writeFileSync(path.join(root, "selections", "current.json"), canonicalJson({
    schema_version: freshness.PROPOSITION_LIFECYCLE_FRESHNESS_SELECTION_POINTER_SCHEMA,
    selection_hash: selectionHash,
  }), "utf8");
}

function writeHead(root, head) {
  writeCasRecord(root, "heads", head.head_hash, "head.json", head);
}

function writeSelection(root, selection) {
  writeCasRecord(root, "selections", selection.selection_hash, "selection.json", selection);
}

function writeIntent(root, intent) {
  writeCasRecord(root, "intents", intent.intent_hash, "intent.json", intent);
}

function selectHead(root, baseSelection, head) {
  const selection = clone(baseSelection);
  selection.generation = head.generation;
  selection.head_hash = head.head_hash;
  selection.head_generation = head.generation;
  const rehashed = rehash(selection, "selection_hash");
  writeHead(root, head);
  writeSelection(root, rehashed);
  setHeadPointer(root, head.head_hash);
  setSelectionPointer(root, rehashed.selection_hash);
  return rehashed;
}

function makeProductionCommitted() {
  const stagedEvent = {
    event_id: excludedId,
    canonical_event_bytes_sha256: hash(fs.readFileSync(eventPath(sourceB, excludedId))),
  };
  const precondition = {
    expected_predecessor_head_hash: buildA.head.head_hash,
    expected_predecessor_selection_hash: buildA.selection.selection_hash,
    expected_generation: 1,
    expected_selection_seq: 0,
  };
  const expectedPostAppend = {
    input_event_count: buildB.head.source.input_event_count,
    input_event_ids_hash: buildB.head.source.input_event_ids_hash,
    corpus_hash: freshness.__TEST.corpusHash(buildB.head.source.input_event_count, buildB.head.source.input_event_ids_hash),
    coverage_hash: buildB.head.coverage_hash,
    p2a_bundle_hash: buildB.head.p2a.bundle_hash,
  };
  const transactionId = freshness.__TEST.transactionId(stagedEvent, precondition, expectedPostAppend);
  const intentBase = {
    schema_version: freshness.PROPOSITION_LIFECYCLE_FRESHNESS_WRITER_INTENT_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_algorithm: "sha256",
    intent_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this writer intent object with intent_hash and audit omitted",
    authority: "future_production_writer_fencing_separate_gate",
    transaction_id_rule: "sha256 over RFC8785-JCS of staged_event, precondition, and expected_post_append",
    transaction_id: transactionId,
    staged_event: stagedEvent,
    precondition,
    expected_post_append: expectedPostAppend,
    fencing: {
      writer_id_hash: hash("fixture-production-writer"),
      fence_epoch: 7,
      fence_token_hash: hash("fixture-production-fence"),
      compare_and_swap_required: true,
      recheck_sequence: ["C0", "C1", "Ccommit"],
    },
    recovery: clone(freshness.__TEST.recoveryContract),
    constraints: {
      immutable_l1_append_only: true,
      exact_staged_bytes_required: true,
      lazy_p2a_and_stable_cas: true,
      selection_only_artifact_activation: true,
      head_first_pointer_advance: true,
      no_time_freshness_gate: true,
    },
    audit: clone(freshness.__TEST.auditContract),
  };
  const intent = rehash(intentBase, "intent_hash");
  freshness.validatePropositionLifecycleFreshnessWriterIntent(intent);
  const head = clone(buildB.head);
  head.writer_protocol = {
    protocol: "staged_event_intent_then_fenced_commit/v1",
    mode: "production",
    state: "committed",
    intent_hash: intent.intent_hash,
    fence_token_hash: intent.fencing.fence_token_hash,
    commit_proof_hash: hash("fixture-production-commit-proof"),
    abort_authorization_hash: null,
    transaction: {
      transaction_id: transactionId,
      staged_event_id: stagedEvent.event_id,
      staged_canonical_event_bytes_sha256: stagedEvent.canonical_event_bytes_sha256,
      expected_predecessor_selection_hash: precondition.expected_predecessor_selection_hash,
      expected_post_append_corpus_hash: expectedPostAppend.corpus_hash,
    },
  };
  const rehashedHead = rehash(head, "head_hash");
  freshness.validatePropositionLifecycleFreshnessHead(rehashedHead);
  const selection = clone(buildB.selection);
  selection.head_hash = rehashedHead.head_hash;
  selection.head_generation = rehashedHead.generation;
  const rehashedSelection = rehash(selection, "selection_hash");
  freshness.validatePropositionLifecycleFreshnessSelection(rehashedSelection);
  return { intent, head: rehashedHead, selection: rehashedSelection };
}

function installProductionCommitted(root, records = productionCommitted) {
  writeIntent(root, records.intent);
  writeHead(root, records.head);
  writeSelection(root, records.selection);
  setHeadPointer(root, records.head.head_hash);
  setSelectionPointer(root, records.selection.selection_hash);
}

console.log("ADR0040 lifecycle-aware freshness D3 dual-pointer smoke");
copyEvents(sourceA, [genesisId, policyId]);
copyEvents(sourceB, [genesisId, policyId, excludedId]);
fs.writeFileSync(previewRuntimeConfig, "{\"fixture\":true}\n", "utf8");
const previewRuntimeMtime = fs.lstatSync(previewRuntimeConfig).mtime;
fs.utimesSync(previewRuntimeConfig, new Date(Date.now() + 60_000), previewRuntimeMtime);

try {
  await check("deterministic genesis head/selection include immutable chain and authority/config anchors", async () => {
    buildA = await freshness.buildPropositionLifecycleFreshnessShadow({ sourceAbrainHome: sourceA, repoRoot });
    buildA2 = await freshness.buildPropositionLifecycleFreshnessShadow({ sourceAbrainHome: sourceA, repoRoot });
    assert(buildA.head.generation === 0 && buildA.head.predecessor_head_hash === null, "head genesis rule differs");
    assert(buildA.selection.generation === 0 && buildA.selection.seq === 0 && buildA.selection.predecessor_selection_hash === null, "selection genesis rule differs");
    assert(buildA.selection.authority_binding.config_trust_anchor_hash === freshness.PROPOSITION_LIFECYCLE_FRESHNESS_SHADOW_CONFIG_HASH, "selection config anchor differs");
    assert(buildA.head.head_hash === buildA2.head.head_hash && buildA.selection.selection_hash === buildA2.selection.selection_hash, "genesis identities are nondeterministic");
    assert(!canonicalJson(buildA.selection).includes("observed_at"), "selection identity contains time");
  });

  await check("initial materialization creates head pointer before the sole selection activation and has no root current", async () => {
    const result = await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: outputA, build: buildA });
    assert(result.status === "created", `initial status=${result.status}`);
    assert(result.head_pointer_path === path.join(outputA, "heads", "current.json"), "head pointer path differs");
    assert(result.selection_pointer_path === path.join(outputA, "selections", "current.json"), "selection pointer path differs");
    assert(!fs.existsSync(path.join(outputA, "current.json")), "forbidden root current exists");
    const readback = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: outputA });
    assert(readback.ok && readback.headGeneration === 0 && readback.selectionSeq === 0, `readback=${JSON.stringify(readback)}`);
  });

  await check("idempotent rerun fully reads back CAS without replacing pointers or artifacts", async () => {
    const headInode = fs.lstatSync(path.join(outputA, "heads", "current.json")).ino;
    const selectionInode = fs.lstatSync(path.join(outputA, "selections", "current.json")).ino;
    const view = path.join(outputA, "stable", "v1", "bundles", buildA.stable_bundle.bundle_hash, "view.md");
    const viewInode = fs.lstatSync(view).ino;
    const result = await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: outputA, build: buildA2 });
    assert(result.status === "identical", `rerun status=${result.status}`);
    assert(fs.lstatSync(path.join(outputA, "heads", "current.json")).ino === headInode, "identical rerun replaced head pointer");
    assert(fs.lstatSync(path.join(outputA, "selections", "current.json")).ino === selectionInode, "identical rerun replaced selection pointer");
    assert(fs.lstatSync(view).ino === viewInode, "identical rerun replaced artifact CAS");
  });

  await check("successor build enforces contiguous head generation and selection seq chains", async () => {
    buildB = await freshness.buildPropositionLifecycleFreshnessShadow({
      sourceAbrainHome: sourceB,
      repoRoot,
      predecessor: { head: buildA.head, selection: buildA.selection },
    });
    assert(buildB.head.generation === 1 && buildB.head.predecessor_head_hash === buildA.head.head_hash, "head successor differs");
    assert(buildB.selection.generation === 1 && buildB.selection.seq === 1 && buildB.selection.predecessor_selection_hash === buildA.selection.selection_hash, "selection successor differs");
    assert(buildA.stable_bundle.artifacts["view.md"] === buildB.stable_bundle.artifacts["view.md"], "same-render fixture unexpectedly changed");
    assert(buildA.selection.selection_hash !== buildB.selection.selection_hash, "new head reused old selection identity");
  });

  await check("head pointer at intent while selection pointer stays old falls back as head_noncommitted", async () => {
    const root = cloneOutput("window-intent-old-selection");
    const candidate = makeProductionCommitted();
    const intentHead = clone(candidate.head);
    intentHead.writer_protocol.state = "intent";
    intentHead.writer_protocol.fence_token_hash = null;
    intentHead.writer_protocol.commit_proof_hash = null;
    const rehashedHead = rehash(intentHead, "head_hash");
    writeIntent(root, candidate.intent);
    writeHead(root, rehashedHead);
    setHeadPointer(root, rehashedHead.head_hash);
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "head_noncommitted", `intent window=${JSON.stringify(result)}`);
    assert(JSON.parse(fs.readFileSync(path.join(root, "selections", "current.json"))).selection_hash === buildA.selection.selection_hash, "test incorrectly advanced selection pointer");
  });

  await check("head pointer at new committed head while selection pointer stays old fails head_selection_mismatch", async () => {
    const root = cloneOutput("window-committed-old-selection");
    writeHead(root, buildB.head);
    setHeadPointer(root, buildB.head.head_hash);
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "head_selection_mismatch", `committed window=${JSON.stringify(result)}`);
  });

  await check("normal advance writes immutable CAS and ends with matching head and selection pointers", async () => {
    const result = await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: outputA, build: buildB });
    assert(result.status === "advanced", `advance status=${result.status}`);
    assert(fs.existsSync(path.join(outputA, "heads", "v1", buildA.head.head_hash, "head.json")), "predecessor head disappeared");
    assert(fs.existsSync(path.join(outputA, "selections", "v1", buildA.selection.selection_hash, "selection.json")), "predecessor selection disappeared");
    const readback = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: outputA });
    assert(readback.ok && readback.headHash === buildB.head.head_hash && readback.selectionHash === buildB.selection.selection_hash, `advanced readback=${JSON.stringify(readback)}`);
  });

  await check("missing artifact on same pointers is repaired and never reported as a false identical", async () => {
    const view = path.join(outputA, "stable", "v1", "bundles", buildB.stable_bundle.bundle_hash, "view.md");
    fs.unlinkSync(view);
    const result = await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: outputA, build: buildB });
    assert(result.status === "recovered", `repair status=${result.status}`);
    assert(fs.readFileSync(view, "utf8") === buildB.stable_bundle.artifacts["view.md"], "repaired artifact readback differs");
  });

  await check("CAS collision fails closed and never overwrites existing bytes", async () => {
    const root = cloneOutput("cas-collision");
    const view = path.join(root, "stable", "v1", "bundles", buildB.stable_bundle.bundle_hash, "view.md");
    fs.writeFileSync(view, "collision\n", "utf8");
    let caught;
    try { await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: root, build: buildB }); } catch (error) { caught = error; }
    assert(caught?.code === "cas_collision", `collision was not rejected: ${caught?.code || caught}`);
    assert(fs.readFileSync(view, "utf8") === "collision\n", "collision bytes were overwritten");
  });

  await check("concurrent genesis mkdir/create races converge to exact bytes", async () => {
    const root = path.join(tmpRoot, "concurrent-genesis");
    await Promise.all([
      freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: root, build: buildA }),
      freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: root, build: buildA2 }),
    ]);
    const readback = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(readback.ok && readback.headHash === buildA.head.head_hash, `concurrent readback=${JSON.stringify(readback)}`);
  });

  await check("blocked selection is fail-closed and keeps P2a/stable CAS lazy", async () => {
    blockedBuild = await freshness.buildPropositionLifecycleFreshnessShadow({ sourceAbrainHome: sourceA, repoRoot, selection: "blocked", blockReasonCode: "fixture_blocked", blockDetail: { fixture: true } });
    const root = path.join(tmpRoot, "blocked-output");
    await freshness.materializePropositionLifecycleFreshnessShadow({ outputRoot: root, build: blockedBuild });
    assert(!fs.existsSync(path.join(root, "p2a")) && !fs.existsSync(path.join(root, "stable")), "blocked build eagerly wrote artifact CAS");
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "selection_blocked" && result.error === "fixture_blocked", `blocked=${JSON.stringify(result)}`);
  });

  await check("head and selection pointer missing errors are distinct and head is checked first", async () => {
    const missingSelection = cloneOutput("missing-selection-pointer");
    fs.unlinkSync(path.join(missingSelection, "selections", "current.json"));
    const selectionResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: missingSelection });
    assert(!selectionResult.ok && selectionResult.reason === "selection_pointer_missing", `missing selection=${JSON.stringify(selectionResult)}`);
    const missingHead = cloneOutput("missing-head-pointer");
    fs.unlinkSync(path.join(missingHead, "heads", "current.json"));
    const headResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: missingHead });
    assert(!headResult.ok && headResult.reason === "head_pointer_missing", `missing head=${JSON.stringify(headResult)}`);
  });

  await check("head pointer ABA replace-with-same-bytes fails closed before selection secondary read", async () => {
    const root = cloneOutput("head-pointer-aba");
    const pointer = path.join(root, "heads", "current.json");
    const raw = fs.readFileSync(pointer, "utf8");
    const result = freshness.readPropositionLifecycleFreshnessShadow({
      outputRoot: root,
      afterFirstPointerReads() {
        fs.unlinkSync(pointer);
        fs.writeFileSync(pointer, raw, "utf8");
      },
    });
    assert(!result.ok && result.reason === "head_pointer_aba", `head ABA=${JSON.stringify(result)}`);
  });

  await check("selection pointer ABA replace-with-same-bytes fails closed", async () => {
    const root = cloneOutput("selection-pointer-aba");
    const pointer = path.join(root, "selections", "current.json");
    const raw = fs.readFileSync(pointer, "utf8");
    const result = freshness.readPropositionLifecycleFreshnessShadow({
      outputRoot: root,
      afterFirstPointerReads() {
        fs.unlinkSync(pointer);
        fs.writeFileSync(pointer, raw, "utf8");
      },
    });
    assert(!result.ok && result.reason === "selection_pointer_aba", `selection ABA=${JSON.stringify(result)}`);
  });

  await check("root current compatibility path and artifact secondary pointers are rejected", async () => {
    const rootCurrent = cloneOutput("forbidden-root-current");
    fs.writeFileSync(path.join(rootCurrent, "current.json"), "{}\n", "utf8");
    const rootResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: rootCurrent });
    assert(!rootResult.ok && rootResult.reason === "secondary_activation_forbidden", `root current=${JSON.stringify(rootResult)}`);
    const secondary = cloneOutput("forbidden-secondary");
    fs.writeFileSync(path.join(secondary, "p2a", "current.json"), "{}\n", "utf8");
    const secondaryResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: secondary });
    assert(!secondaryResult.ok && secondaryResult.reason === "secondary_activation_forbidden", `artifact secondary=${JSON.stringify(secondaryResult)}`);
    const controlSecondary = cloneOutput("forbidden-control-secondary");
    fs.writeFileSync(path.join(controlSecondary, "heads", "latest"), "{}\n", "utf8");
    const controlResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: controlSecondary });
    assert(!controlResult.ok && controlResult.reason === "secondary_activation_forbidden", `control secondary=${JSON.stringify(controlResult)}`);
  });

  await check("head and selection successor discontinuities fail immutable-chain validation", async () => {
    const badHeadRoot = cloneOutput("bad-head-chain");
    const badHead = clone(buildB.head);
    badHead.generation = 2;
    const rehashedHead = rehash(badHead, "head_hash");
    selectHead(badHeadRoot, buildB.selection, rehashedHead);
    const headResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: badHeadRoot });
    assert(!headResult.ok && headResult.reason === "head_chain_invalid", `bad head chain=${JSON.stringify(headResult)}`);

    const badSelectionRoot = cloneOutput("bad-selection-chain");
    const badSelection = clone(buildB.selection);
    badSelection.seq = 3;
    const rehashedSelection = rehash(badSelection, "selection_hash");
    writeSelection(badSelectionRoot, rehashedSelection);
    setSelectionPointer(badSelectionRoot, rehashedSelection.selection_hash);
    const selectionResult = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: badSelectionRoot });
    assert(!selectionResult.ok && selectionResult.reason === "selection_chain_invalid", `bad selection chain=${JSON.stringify(selectionResult)}`);
  });

  await check("production committed head validates exact staged intent before artifact reads", async () => {
    productionCommitted = makeProductionCommitted();
    const root = cloneOutput("production-committed-positive");
    installProductionCommitted(root);
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(result.ok && result.headHash === productionCommitted.head.head_hash, `production committed=${JSON.stringify(result)}`);
  });

  await check("legal forward selection on the same production head validates the exact intent predecessor edge", async () => {
    const root = cloneOutput("production-forward-selection");
    installProductionCommitted(root);
    const forward = clone(productionCommitted.selection);
    forward.seq += 1;
    forward.predecessor_selection_hash = productionCommitted.selection.selection_hash;
    const rehashedForward = rehash(forward, "selection_hash");
    writeSelection(root, rehashedForward);
    setSelectionPointer(root, rehashedForward.selection_hash);
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(result.ok && result.selectionHash === rehashedForward.selection_hash && result.headHash === productionCommitted.head.head_hash, `forward selection=${JSON.stringify(result)}`);
  });

  await check("production committed missing intent fails before P2a/stable", async () => {
    const root = cloneOutput("production-intent-missing");
    installProductionCommitted(root);
    fs.rmSync(path.join(root, "intents", "v1", productionCommitted.intent.intent_hash), { recursive: true, force: true });
    fs.rmSync(path.join(root, "stable", "v1", "bundles", buildB.stable_bundle.bundle_hash), { recursive: true, force: true });
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "intent_missing", `missing intent ordering=${JSON.stringify(result)}`);
  });

  await check("production committed intent/head staged binding mismatch fails before missing artifacts", async () => {
    const root = cloneOutput("production-intent-mismatch");
    const mismatchedHead = clone(productionCommitted.head);
    mismatchedHead.writer_protocol.transaction.staged_canonical_event_bytes_sha256 = "f".repeat(64);
    const rehashedHead = rehash(mismatchedHead, "head_hash");
    const selection = clone(productionCommitted.selection);
    selection.head_hash = rehashedHead.head_hash;
    const rehashedSelection = rehash(selection, "selection_hash");
    installProductionCommitted(root, { intent: productionCommitted.intent, head: rehashedHead, selection: rehashedSelection });
    fs.rmSync(path.join(root, "stable", "v1", "bundles", buildB.stable_bundle.bundle_hash), { recursive: true, force: true });
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "intent_head_mismatch", `intent mismatch ordering=${JSON.stringify(result)}`);
  });

  await check("aborted production head requires explicit authorization and never activates artifacts", async () => {
    const invalidAborted = clone(productionCommitted.head);
    invalidAborted.writer_protocol.state = "aborted";
    invalidAborted.writer_protocol.commit_proof_hash = null;
    invalidAborted.writer_protocol.abort_authorization_hash = null;
    let caught;
    try { freshness.validatePropositionLifecycleFreshnessHead(rehash(invalidAborted, "head_hash")); } catch (error) { caught = error; }
    assert(caught?.code === "hash_invalid", `unauthorized abort accepted as ${caught?.code || caught}`);

    const root = cloneOutput("production-aborted");
    invalidAborted.writer_protocol.abort_authorization_hash = hash("separately-authorized-abort");
    const aborted = rehash(invalidAborted, "head_hash");
    writeHead(root, aborted);
    setHeadPointer(root, aborted.head_hash);
    const result = freshness.readPropositionLifecycleFreshnessShadow({ outputRoot: root });
    assert(!result.ok && result.reason === "head_noncommitted", `aborted=${JSON.stringify(result)}`);
  });

  await check("writer intent recovery contract forbids TTL auto-abort and rejects missing recovery fields", async () => {
    assert(productionCommitted.intent.recovery.no_ttl_auto_abort === true, "intent permits TTL auto-abort");
    assert(productionCommitted.intent.recovery.explicit_abort_requires_separate_authorization === true, "intent lacks separate abort authorization");
    const intentKeys = canonicalJson(productionCommitted.intent);
    assert(!intentKeys.includes("expiry") && !intentKeys.includes("expires_at") && !intentKeys.includes("deadline") && !intentKeys.includes('"ttl_ms"'), "intent contains an expiry/deadline/TTL guess field");
    const attacked = clone(productionCommitted.intent);
    delete attacked.recovery.no_ttl_auto_abort;
    let caught;
    try { freshness.validatePropositionLifecycleFreshnessWriterIntent(rehash(attacked, "intent_hash")); } catch (error) { caught = error; }
    assert(caught?.code === "shape_invalid", `incomplete recovery accepted as ${caught?.code || caught}`);
  });

  await check("preview observes unrelated whole-tree concurrency without blocking unchanged protected surfaces", async () => {
    const source = path.join(tmpRoot, "preview-unrelated-source");
    copyEvents(source, [genesisId, policyId]);
    const report = await runPropositionLifecycleFreshnessPreview({
      sourceAbrainHome: source,
      runtimeConfigPath: previewRuntimeConfig,
      outputRoot: path.join(tmpRoot, "preview-unrelated-output"),
      afterPreviewReadbackForTest() {
        const unrelated = path.join(source, ".state", "sediment", "unrelated-sidecar", "observed.json");
        fs.mkdirSync(path.dirname(unrelated), { recursive: true });
        fs.writeFileSync(unrelated, "{\"concurrent\":true}\n", "utf8");
      },
    });
    const whole = report.measured_evidence.source_abrain_whole_tree;
    const protectedEvidence = report.measured_evidence.protected_surfaces;
    assert(whole.unchanged === false && whole.whole_tree_concurrent_change_observed === true && whole.blocking_read_only_gate === false, "unrelated whole-tree concurrency was not reported as observed nonblocking change");
    assert(protectedEvidence.unchanged === true && protectedEvidence.blocking_read_only_gate === true && protectedEvidence.comparisons.every((surface) => surface.unchanged), "unchanged protected surfaces did not pass the blocking gate");
    const d3Comparisons = protectedEvidence.comparisons.filter((surface) => surface.name.startsWith("production_d3"));
    assert(d3Comparisons.length === 1 && d3Comparisons[0].name === "production_d3_root", "D3 protection was split into incomplete child roots");
    assert(d3Comparisons[0].before_state === "missing" && d3Comparisons[0].after_state === "missing" && d3Comparisons[0].unchanged === true, "whole D3 root absence was not proven before and after for all future descendants and root pointers");
    assert(report.measured_evidence.runtime_config_exact_file.unchanged === true, "runtime config exact-file evidence was not unchanged");
  });

  await check("preview blocks creation of an illegal pointer anywhere under the previously missing D3 root", async () => {
    const source = path.join(tmpRoot, "preview-d3-root-pointer-source");
    copyEvents(source, [genesisId, policyId]);
    let caught;
    try {
      await runPropositionLifecycleFreshnessPreview({
        sourceAbrainHome: source,
        runtimeConfigPath: previewRuntimeConfig,
        outputRoot: path.join(tmpRoot, "preview-d3-root-pointer-output"),
        afterPreviewReadbackForTest() {
          const pointer = path.join(source, ".state", "sediment", "proposition-lifecycle-freshness", "v1", "current.json");
          fs.mkdirSync(path.dirname(pointer), { recursive: true });
          fs.writeFileSync(pointer, "{}\n", "utf8");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert(caught?.code === "PROTECTED_SURFACE_CHANGED", `illegal D3 root pointer was not rejected: ${caught?.code || caught}`);
    const change = caught.detail?.changes?.find((surface) => surface.name === "production_d3_root");
    assert(change?.before_state === "missing" && change.after_state === "present", "whole D3 root rejection did not prove missing-to-present");
  });

  await check("preview blocks protected mode changes and same-byte inode replacement", async () => {
    const cases = [
      {
        label: "mode",
        mutate(file) {
          const permissions = fs.lstatSync(file).mode & 0o777;
          fs.chmodSync(file, permissions === 0o600 ? 0o640 : 0o600);
        },
      },
      {
        label: "inode",
        mutate(file) {
          const bytes = fs.readFileSync(file);
          const permissions = fs.lstatSync(file).mode & 0o777;
          fs.unlinkSync(file);
          fs.writeFileSync(file, bytes);
          fs.chmodSync(file, permissions);
        },
      },
    ];
    for (const testCase of cases) {
      const source = path.join(tmpRoot, `preview-protected-${testCase.label}-source`);
      copyEvents(source, [genesisId, policyId]);
      let caught;
      try {
        await runPropositionLifecycleFreshnessPreview({
          sourceAbrainHome: source,
          runtimeConfigPath: previewRuntimeConfig,
          outputRoot: path.join(tmpRoot, `preview-protected-${testCase.label}-output`),
          afterPreviewReadbackForTest() { testCase.mutate(eventPath(source, policyId)); },
        });
      } catch (error) {
        caught = error;
      }
      assert(caught?.code === "PROTECTED_SURFACE_CHANGED", `protected ${testCase.label} change was not rejected: ${caught?.code || caught}`);
      assert(caught.detail?.changes?.some((surface) => surface.name === "canonical_l1_source"), `protected ${testCase.label} rejection did not identify canonical_l1_source`);
    }
  });

  await check("runtime config atime-only change is observed but excluded from blocking identity", async () => {
    const source = path.join(tmpRoot, "preview-runtime-atime-source");
    const runtimeConfig = path.join(tmpRoot, "preview-runtime-atime.json");
    copyEvents(source, [genesisId, policyId]);
    fs.writeFileSync(runtimeConfig, "{\"fixture\":\"atime\"}\n", "utf8");
    const initial = fs.lstatSync(runtimeConfig);
    fs.utimesSync(runtimeConfig, new Date(0), initial.mtime);
    const report = await runPropositionLifecycleFreshnessPreview({
      sourceAbrainHome: source,
      runtimeConfigPath: runtimeConfig,
      outputRoot: path.join(tmpRoot, "preview-runtime-atime-output"),
    });
    const evidence = report.measured_evidence.runtime_config_exact_file;
    assert(evidence.unchanged === true, "atime-only runtime config change blocked preview");
    assert(evidence.before.stat.atime_ns !== evidence.after.stat.atime_ns, "atime-only runtime config change was not observed");
    assert(JSON.stringify(evidence.before.blocking_stat_identity) === JSON.stringify(evidence.after.blocking_stat_identity), "atime entered runtime config blocking identity");
  });

  await check("runtime config mode change and same-byte inode replacement both block", async () => {
    const cases = [
      {
        label: "mode",
        mutate(file) {
          const permissions = fs.lstatSync(file).mode & 0o777;
          fs.chmodSync(file, permissions === 0o600 ? 0o640 : 0o600);
        },
      },
      {
        label: "inode",
        mutate(file) {
          const bytes = fs.readFileSync(file);
          const permissions = fs.lstatSync(file).mode & 0o777;
          fs.unlinkSync(file);
          fs.writeFileSync(file, bytes);
          fs.chmodSync(file, permissions);
        },
      },
    ];
    for (const testCase of cases) {
      const source = path.join(tmpRoot, `preview-runtime-${testCase.label}-source`);
      const runtimeConfig = path.join(tmpRoot, `preview-runtime-${testCase.label}.json`);
      copyEvents(source, [genesisId, policyId]);
      fs.writeFileSync(runtimeConfig, "{\"fixture\":true}\n", "utf8");
      let caught;
      try {
        await runPropositionLifecycleFreshnessPreview({
          sourceAbrainHome: source,
          runtimeConfigPath: runtimeConfig,
          outputRoot: path.join(tmpRoot, `preview-runtime-${testCase.label}-output`),
          afterPreviewReadbackForTest({ runtimeConfigPath }) { testCase.mutate(runtimeConfigPath); },
        });
      } catch (error) {
        caught = error;
      }
      assert(caught?.code === "RUNTIME_CONFIG_CHANGED", `runtime config ${testCase.label} change was not rejected: ${caught?.code || caught}`);
    }
  });

  await check("preview blocks a protected canonical L1 source change", async () => {
    const source = path.join(tmpRoot, "preview-protected-source");
    copyEvents(source, [genesisId, policyId]);
    let caught;
    try {
      await runPropositionLifecycleFreshnessPreview({
        sourceAbrainHome: source,
        runtimeConfigPath: previewRuntimeConfig,
        outputRoot: path.join(tmpRoot, "preview-protected-output"),
        afterPreviewReadbackForTest() {
          fs.appendFileSync(eventPath(source, policyId), " ", "utf8");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert(caught?.code === "PROTECTED_SURFACE_CHANGED", `protected L1 change was not rejected: ${caught?.code || caught}`);
    assert(caught.detail?.changes?.some((surface) => surface.name === "canonical_l1_source"), "protected L1 rejection did not identify canonical_l1_source");
  });

  await check("production and non-temp output paths remain rejected", async () => {
    for (const target of ["/home/worker/.abrain", "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1", repoRoot, os.tmpdir()]) {
      let caught;
      try { freshness.assertPropositionLifecycleFreshnessSandboxOutputRoot(target); } catch (error) { caught = error; }
      assert(caught && ["sandbox_output_required", "production_output_forbidden"].includes(caught.code), `${target} was not rejected: ${caught?.code}`);
    }
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks; dual-pointer freshness/activation, immutable chains, staged writer intent, durable CAS, ABA defense, and temp-only confinement verified`);
