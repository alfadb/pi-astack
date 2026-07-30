#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const authority = jiti(path.join(repoRoot, "extensions/_shared/canonical-mutation-authority.ts"));
const barrier = jiti(path.join(repoRoot, "extensions/_shared/canonical-mutation-barrier.ts"));
const lsea = jiti(path.join(repoRoot, "extensions/sediment/local-executor-authority.ts"));
const writer = jiti(path.join(repoRoot, "extensions/sediment/writer.ts"));
const knowledge = jiti(path.join(repoRoot, "extensions/sediment/knowledge-evidence.ts"));
const outcome = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
const constraintAppend = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/append.ts"));
const constraintTypes = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/types.ts"));
const constraintHash = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/hash-envelope.ts"));
const projection = jiti(path.join(repoRoot, "extensions/sediment/constraint-compiler/projection.ts"));
const tier1 = jiti(path.join(repoRoot, "extensions/_shared/proposition-tier1-policy-writer.ts"));
const genesisWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
const evidenceWriter = jiti(path.join(repoRoot, "extensions/_shared/proposition-evidence-writer.ts"));
const constraintIntegration = jiti(path.join(repoRoot, "extensions/sediment/constraint-evidence/integration.ts"));
const isolatedJiti = createJiti(path.join(repoRoot, "scripts", "mutation-authority-isolated-entry.mjs"), {
  interopDefault: true,
  moduleCache: false,
});
const isolatedAuthority = isolatedJiti(path.join(repoRoot, "extensions/_shared/canonical-mutation-authority.ts"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-mutation-authority-"));
let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function check(name, operation) {
  try {
    await operation();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`);
  }
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

const epoch = "19";
const holderNonce = hex64("mutation-authority-holder");

function createHome(name, withStore = true) {
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (withStore) writeAuthorityStore(home);
  return home;
}

function writeAuthorityStore(home) {
  const directory = path.join(home, ".state", "sediment", "local-executor-authority");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = {
    schema: "pi-router/local-sediment-executor-authority/v1",
    local_executor_epoch: epoch,
    mode: "held",
    holder_kind: "daemon",
    holder_nonce: holderNonce,
    state_dir_key: hex64("mutation-authority-state"),
    run_nonce: hex64("mutation-authority-run"),
  };
  fs.writeFileSync(path.join(directory, "authority.lock"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "authority.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function exactDaemonRevalidate(home, lockState) {
  return () => {
    const admission = lsea.admitLocalExecutorAuthority({
      abrainHome: home,
      expectation: {
        local_executor_epoch: epoch,
        local_executor_holder_nonce: holderNonce,
      },
      expectedHolderKind: "daemon",
      observation: { observeLock: () => lockState.value },
    });
    if (admission.regime !== "strict") throw new Error("strict daemon authority required");
  };
}

async function expectClosed(operation, forbidden = []) {
  let caught;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught?.code === authority.CANONICAL_MUTATION_NOT_AUTHORIZED, `code=${caught?.code}`);
  assert(caught?.message === authority.CANONICAL_MUTATION_NOT_AUTHORIZED, `message=${caught?.message}`);
  for (const value of forbidden) {
    assert(!String(caught.message).includes(value), `closed error leaked ${value}`);
  }
}

function spawnBarrierHolder(home, heldMarker, releaseMarker) {
  const code = `const {createJiti}=require('jiti');const fs=require('node:fs'),p=require('node:path');(async()=>{const j=createJiti(${JSON.stringify(repoRoot)},{interopDefault:true});const b=j(p.join(${JSON.stringify(repoRoot)},'extensions/_shared/canonical-mutation-barrier.ts'));await b.withCanonicalMutationBarrier(${JSON.stringify(home)},async()=>{fs.writeFileSync(${JSON.stringify(heldMarker)},'held\\n');while(!fs.existsSync(${JSON.stringify(releaseMarker)}))await new Promise((r)=>setTimeout(r,10));});})().catch((e)=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ["-e", code], {
    cwd: repoRoot,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("close", (status, signal) => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `holder exited ${status}/${signal}`));
    });
  });
  return { child, closed };
}

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function canonicalTree(home) {
  const rows = [];
  const walk = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relative && name === ".state") continue;
      const absolute = path.join(directory, name);
      const rel = path.join(relative, name).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        rows.push(`d:${rel}`);
        walk(absolute, rel);
      } else if (stat.isFile()) {
        rows.push(`f:${rel}:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
      } else if (stat.isSymbolicLink()) {
        rows.push(`l:${rel}:${fs.readlinkSync(absolute)}`);
      }
    }
  };
  walk(home);
  return rows.join("\n");
}

process.stdout.write("smoke: canonical mutation authority execution-time fence\n");

await check("store absent wait then present before real OFD acquisition rejects with operation=0", async () => {
  const home = createHome("cutover-race", false);
  const heldMarker = path.join(tmp, "cutover-held");
  const releaseMarker = path.join(tmp, "cutover-release");
  const target = path.join(home, "knowledge", "must-not-write.txt");
  const holder = spawnBarrierHolder(home, heldMarker, releaseMarker);
  try {
    await waitFor("real OFD holder", () => fs.existsSync(heldMarker));
    let probes = 0;
    let firstProbeResolve;
    const firstProbe = new Promise((resolve) => { firstProbeResolve = resolve; });
    let operations = 0;
    const waiting = barrier.withCanonicalMutationBarrier(home, async () => {
      operations += 1;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "unauthorized\n");
    }, {
      timeoutMs: 5_000,
      retryMs: 10,
      maxRetryMs: 20,
      onProbe: () => {
        probes += 1;
        firstProbeResolve();
      },
    });
    await firstProbe;
    assert(probes >= 1, "contender never probed the held OFD lock");
    writeAuthorityStore(home);
    const before = canonicalTree(home);
    fs.writeFileSync(releaseMarker, "release\n");
    await expectClosed(() => waiting, [home, target]);
    await holder.closed;
    assert(operations === 0, `operation count=${operations}`);
    assert(!fs.existsSync(target), "target was created after cutover");
    assert(canonicalTree(home) === before, "canonical tree changed after denied acquisition");
  } finally {
    fs.writeFileSync(releaseMarker, "release\n");
    holder.child.kill("SIGTERM");
    await holder.closed.catch(() => undefined);
  }
});

await check("same-root held daemon lease writes; wrong root and held-to-free revocation reject", async () => {
  const home = createHome("same-root");
  const other = createHome("wrong-root");
  const lockState = { value: "held" };
  let revalidations = 0;
  const target = path.join(home, "knowledge", "authorized.txt");
  await authority.withCanonicalMutationAuthority({
    abrainHome: home,
    role: "daemon",
    revalidate: () => {
      revalidations += 1;
      return exactDaemonRevalidate(home, lockState)();
    },
  }, async () => {
    await barrier.withCanonicalMutationBarrier(home, async () => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "authorized\n");
    });
    await expectClosed(() => authority.assertCanonicalMutationAuthorized(other), [home, other]);
    lockState.value = "free";
    await expectClosed(() => authority.assertCanonicalMutationAuthorized(home), [home]);
  });
  assert(fs.readFileSync(target, "utf8") === "authorized\n", "same-root daemon write missing");
  assert(revalidations >= 3, `expected barrier execution-time revalidations, got ${revalidations}`);
});

await check("global symbol/version shares active lease across isolated jiti module instances", async () => {
  const home = createHome("jiti-shared-state");
  const lockState = { value: "held" };
  await authority.withCanonicalMutationAuthority({
    abrainHome: home,
    role: "daemon",
    revalidate: exactDaemonRevalidate(home, lockState),
  }, () => isolatedAuthority.assertCanonicalMutationAuthorized(home));
});

await check("settled lease invalidates detached inherited continuation", async () => {
  const home = createHome("detached-invalid");
  const lockState = { value: "held" };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let detached;
  await authority.withCanonicalMutationAuthority({
    abrainHome: home,
    role: "daemon",
    revalidate: exactDaemonRevalidate(home, lockState),
  }, async () => {
    detached = (async () => {
      await gate;
      await expectClosed(() => authority.assertCanonicalMutationAuthorized(home), [home]);
    })();
  });
  release();
  await detached;
});

await check("store-present gitCommit=false writer has foreground zero delta and daemon success", async () => {
  const home = createHome("semantic-writer");
  const target = path.join(home, "workflows", "dynamic-authority-writer.md");
  const draft = {
    title: "Dynamic authority writer",
    trigger: "execution-time mutation authority smoke",
    body: "This workflow has enough content to prove a semantic canonical writer is fenced even when Git commits are disabled.",
    crossProject: true,
    slug: "dynamic-authority-writer",
  };
  const options = {
    abrainHome: home,
    settings: { gitCommit: false, lockTimeoutMs: 5_000 },
  };
  const before = canonicalTree(home);
  await expectClosed(() => writer.writeAbrainWorkflow(draft, options), [home, target]);
  assert(!fs.existsSync(target), "foreground writer created canonical target");
  assert(canonicalTree(home) === before, "foreground writer changed canonical tree");

  const lockState = { value: "held" };
  const daemon = await authority.withCanonicalMutationAuthority({
    abrainHome: home,
    role: "daemon",
    revalidate: exactDaemonRevalidate(home, lockState),
  }, () => writer.writeAbrainWorkflow(draft, options));
  assert(daemon.status === "created", `daemon status=${daemon.status}`);
  assert(fs.existsSync(target), "daemon writer did not create canonical target");
});

function knowledgeBody(seq) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: `2026-07-30T08:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "device-authority",
    device_event_seq: seq,
    producer_nonce: `knowledge-authority-${seq}`,
    causal_parents: [],
    session_id: "session-authority",
    turn_id: `turn-${seq}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "manual", source_ref: `authority:${seq}` },
    intent: { domain_hint: "knowledge", operation_hint: "create", confidence: 0.9 },
    scope: { kind: "project", project_id: "pi-astack" },
    payload: {
      slug: `authority-knowledge-${seq}`,
      title: `Authority Knowledge ${seq}`,
      kind: "decision",
      status: "active",
      provenance: "authority-smoke",
      confidence: 7,
      compiled_truth: `# Authority Knowledge ${seq}\n\nTracked L1 fence smoke.`,
      trigger_phrases: ["authority knowledge"],
      derives_from: [],
    },
    sanitizer: {
      sanitizer_name: "smoke-sanitizer",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    legacy_parallel_write: { attempted: false, status: "skipped", reason: "authority smoke" },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
}

function constraintBody(seq) {
  return {
    event_schema_version: constraintTypes.CONSTRAINT_EVIDENCE_EVENT_SCHEMA_VERSION,
    event_type: "constraint_signal_observed",
    created_at_utc: "2026-07-30T12:00:00.000Z",
    device_id: "device-authority",
    device_event_seq: seq,
    actor: { role: "user", id: "user-authority" },
    causal_parents: [],
    session_id: "session-authority",
    turn_id: `turn-authority-${seq}`,
    source: {
      channel: "manual",
      source_role: "user",
      source_ref: `turn:session-authority/turn-authority-${seq}#user-1`,
      quote_hash: constraintHash.sha256Hex(`Authority fence ${seq}.`),
    },
    intent: { domain_hint: "constraint", operation_hint: "create", confidence: 0.9 },
    payload: {
      sanitized_quote: `Authority fence ${seq}.`,
      candidate_constraint_text: `Authority fence ${seq}.`,
      candidate_title: `Authority fence ${seq}`,
      candidate_trigger_phrases: ["authority fence"],
      candidate_applies_when: "canonical mutation authority smoke",
      candidate_priority_hint: "always",
    },
    scope: {
      active_project_binding: { project_id: "pi-astack", binding_reason: "cwd" },
      scope_hint: { kind: "project", project_id: "pi-astack", evidence: "current project" },
      scope_confidence: 0.8,
    },
    sanitizer: {
      sanitizer_name: "fixture-sanitizer",
      sanitizer_version: "v1",
      status: "passed",
      replacements_count: 0,
    },
    neighbor_summary: {
      retrieval_mode: "readonly",
      input_hash: constraintHash.sha256Hex("neighbors"),
      neighbor_refs: [{ ref: "rule:global:always:edit-write", scope: "global", title: "edit/write" }],
      summary: "related edit/write rule",
    },
    producer: {
      name: "sediment.constraint-event-writer",
      version: "pr2-fixture",
      code_version: "test",
    },
    privacy: { contains_user_quote: true, redaction_level: "none" },
  };
}

function projectionBody(seq) {
  return {
    event_schema_version: projection.CONSTRAINT_PROJECTION_EVENT_SCHEMA_VERSION,
    event_type: "constraint_compiled_view_produced",
    created_at_utc: `2026-07-30T13:00:${String(seq).padStart(2, "0")}.000Z`,
    device_id: "device-authority",
    producer_nonce: `projection-authority-${seq}`,
    causal_parents: [],
    producer: { name: "sediment.constraint-compiler", version: "authority-smoke" },
    template_version: projection.CONSTRAINT_L2_RENDER_TEMPLATE_VERSION,
    input_root_hash: constraintHash.sha256Hex(`projection-input-${seq}`),
    input_event_ids: [],
    provenance: {
      model: "authority-smoke",
      prompt_hash: constraintHash.sha256Hex("prompt"),
      input_hash: constraintHash.sha256Hex(`projection-input-${seq}`),
      raw_output_hash: constraintHash.sha256Hex(`raw-${seq}`),
      acceptance: "accepted_for_event_append",
    },
    validated_decision: {
      schema: "constraint-compiler-decision/v1",
      inputRootHash: constraintHash.sha256Hex(`projection-input-${seq}`),
      constraints: [],
      smoke_marker: seq,
    },
  };
}

/** revalidate runs again after OFD acquisition, while the lease is already held. */
function daemonWithHeldProbe(home) {
  const state = { heldDuringOperation: false };
  const revalidate = () => {
    exactDaemonRevalidate(home, { value: "held" })();
    if (barrier.canonicalMutationBarrierHeld(home)) state.heldDuringOperation = true;
  };
  return {
    state,
    run: (operation) => authority.withCanonicalMutationAuthority({
      abrainHome: home,
      role: "daemon",
      revalidate,
    }, operation),
  };
}

await check("store-present knowledge/outcome direct writers: foreground zero L1 delta; daemon barrier-held success", async () => {
  const home = createHome("direct-knowledge-outcome");
  const projectRoot = path.join(tmp, "project-knowledge-outcome");
  fs.mkdirSync(projectRoot, { recursive: true });
  const before = canonicalTree(home);

  await expectClosed(() => knowledge.appendKnowledgeEvidenceEvent({
    abrainHome: home,
    body: knowledgeBody(1),
  }), [home]);
  await expectClosed(() => outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome: home,
    projectRoot,
    targetSlug: "authority-outcome",
    producerNonce: "authority-outcome-1",
  }), [home]);
  assert(canonicalTree(home) === before, "foreground knowledge/outcome changed L1 tree");

  const knowledgeProbe = daemonWithHeldProbe(home);
  const knowledgeDaemon = await knowledgeProbe.run(() => knowledge.appendKnowledgeEvidenceEvent({
    abrainHome: home,
    body: knowledgeBody(1),
  }));
  assert(knowledgeDaemon.ok && knowledgeDaemon.status === "appended", `knowledge daemon=${JSON.stringify(knowledgeDaemon)}`);
  assert(knowledgeProbe.state.heldDuringOperation, "knowledge path missed in-operation barrier hold");

  const outcomeProbe = daemonWithHeldProbe(home);
  const outcomeDaemon = await outcomeProbe.run(() => outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome: home,
    projectRoot,
    targetSlug: "authority-outcome",
    producerNonce: "authority-outcome-1",
  }));
  assert(outcomeDaemon.ok, `outcome daemon=${JSON.stringify(outcomeDaemon)}`);
  assert(outcomeProbe.state.heldDuringOperation, "outcome path missed in-operation barrier hold");
  assert(fs.existsSync(knowledgeDaemon.filePath), "knowledge L1 missing after daemon");
  assert(fs.existsSync(outcomeDaemon.filePath), "outcome L1 missing after daemon");
});

await check("store-present constraint/tier1 writers: foreground zero L1 delta; daemon barrier-held success", async () => {
  const home = createHome("direct-constraint-tier1");
  const before = canonicalTree(home);
  await expectClosed(() => constraintAppend.appendConstraintEvidenceEvent({
    abrainHome: home,
    body: constraintBody(1),
  }), [home]);
  assert(canonicalTree(home) === before, "foreground constraint changed L1 tree");

  const constraintProbe = daemonWithHeldProbe(home);
  const constraintDaemon = await constraintProbe.run(() => constraintAppend.appendConstraintEvidenceEvent({
    abrainHome: home,
    body: constraintBody(1),
  }));
  assert(constraintDaemon.ok && constraintDaemon.status === "appended", `constraint daemon=${JSON.stringify(constraintDaemon)}`);
  assert(constraintProbe.state.heldDuringOperation, "constraint append missed in-operation barrier hold");

  const tier1Signal = {
    user_quote: "全局规则：canonical mutation 必须持有 barrier。",
    correction_intent: "global durable policy",
    scope_description: "所有项目 / 全局约定",
    rule_scope: "global",
    confidence: 9,
    provenance: "user",
    quote_source: "user",
    is_directive: true,
  };
  const tier1Draft = {
    title: "authority-tier1",
    body: "全局规则：canonical mutation 必须持有 barrier。",
    entryConfidence: 9,
    triggerPhrases: ["canonical mutation", "barrier"],
    injectMode: "always",
  };
  // Tier-1 needs a real constraint evidence envelope first (store-present daemon path).
  const c = await daemonWithHeldProbe(home).run(() => constraintIntegration.appendTier1ConstraintEvidenceEvent({
    abrainHome: home,
    signal: tier1Signal,
    draft: tier1Draft,
    sessionId: "session-authority",
    turnId: "turn-tier1",
    projectId: "pi-astack",
    cwd: repoRoot,
    createdAtUtc: "2026-07-30T14:00:00.000Z",
    correlationId: "corr-authority-tier1",
    candidateId: "tier1-direct:authority",
    deviceId: "device-authority",
    canonicalPublish: false,
  }));
  assert(c.append?.ok, `tier1 constraint=${JSON.stringify(c)}`);

  const beforeTier1 = canonicalTree(home);
  await expectClosed(() => tier1.appendTier1PolicyProposition({
    abrainHome: home,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: tier1Signal,
    draft: tier1Draft,
    sessionId: "session-authority",
    turnId: "turn-tier1",
  }), [home]);
  assert(canonicalTree(home) === beforeTier1, "foreground tier1 changed L1 tree");

  // Unit: authority must rethrow from the writer catch, never classify as refused.
  let classifiedOrReturned;
  try {
    classifiedOrReturned = await tier1.appendTier1PolicyProposition({
      abrainHome: home,
      constraintEnvelope: c.append.envelope,
      constraintBody: c.body,
      signal: tier1Signal,
      draft: tier1Draft,
      sessionId: "session-authority",
      turnId: "turn-tier1",
    });
  } catch (error) {
    classifiedOrReturned = error;
  }
  assert(authority.isCanonicalMutationAuthorityError(classifiedOrReturned), `tier1 must rethrow authority, got ${JSON.stringify(classifiedOrReturned)}`);

  const tier1Probe = daemonWithHeldProbe(home);
  const tier1Daemon = await tier1Probe.run(() => tier1.appendTier1PolicyProposition({
    abrainHome: home,
    constraintEnvelope: c.append.envelope,
    constraintBody: c.body,
    signal: tier1Signal,
    draft: tier1Draft,
    sessionId: "session-authority",
    turnId: "turn-tier1",
  }));
  assert(tier1Daemon.ok && tier1Daemon.status === "created", `tier1 daemon=${JSON.stringify(tier1Daemon)}`);
  assert(tier1Probe.state.heldDuringOperation, "tier1 append missed in-operation barrier hold");
  assert(fs.existsSync(tier1Daemon.filePath), "tier1 L1 missing after daemon");
});

await check("store-present constraint projection: foreground zero L1 delta; daemon barrier-held success", async () => {
  const home = createHome("direct-projection");
  const body = projectionBody(1);
  const before = canonicalTree(home);
  await expectClosed(() => projection.appendConstraintProjectionEvent(home, body), [home]);
  assert(canonicalTree(home) === before, "foreground projection changed L1 tree");

  const probe = daemonWithHeldProbe(home);
  const daemon = await probe.run(() => projection.appendConstraintProjectionEvent(home, body));
  assert(daemon.ok && daemon.status === "appended", `projection daemon=${JSON.stringify(daemon)}`);
  assert(probe.state.heldDuringOperation, "projection append missed in-operation barrier hold");
  assert(fs.existsSync(daemon.filePath), "projection L1 missing after daemon");
});

await check("store-present fixed genesis/evidence: prestate scan closed without lease; daemon barrier-held success", async () => {
  const home = createHome("direct-genesis-evidence");
  const beforeGenesis = canonicalTree(home);
  await expectClosed(() => genesisWriter.writeProductionPropositionGenesis({ sandboxAbrainHome: home }), [home]);
  assert(canonicalTree(home) === beforeGenesis, "foreground genesis changed L1 tree before prestate scan closed");

  const genesisProbe = daemonWithHeldProbe(home);
  const genesis = await genesisProbe.run(() => genesisWriter.writeProductionPropositionGenesis({ sandboxAbrainHome: home }));
  assert(genesis.status === "created", `genesis daemon=${JSON.stringify(genesis)}`);
  assert(genesisProbe.state.heldDuringOperation, "genesis missed in-operation barrier hold (covers prestate scan)");
  assert(fs.existsSync(genesis.tuple.target_path), "genesis L1 missing after daemon");

  const beforeEvidence = canonicalTree(home);
  await expectClosed(() => evidenceWriter.durableAppendFixedProductionPropositionEvidence({
    abrainHome: home,
    requireFreshPrestate: true,
  }), [home]);
  assert(canonicalTree(home) === beforeEvidence, "foreground fixed evidence changed L1 tree before prestate scan closed");

  const evidenceProbe = daemonWithHeldProbe(home);
  const evidence = await evidenceProbe.run(() => evidenceWriter.durableAppendFixedProductionPropositionEvidence({
    abrainHome: home,
    requireFreshPrestate: true,
  }));
  assert(evidence.status === "created" || evidence.status === "identical", `evidence daemon=${JSON.stringify(evidence)}`);
  assert(evidenceProbe.state.heldDuringOperation, "fixed evidence missed in-operation barrier hold (covers prestate scan)");
  assert(fs.existsSync(evidence.tuple.target_path), "fixed evidence L1 missing after daemon");
  assert(evidence.readback_byte_identical === true, "fixed evidence readback not byte-identical");
});

await check("store-present tracked reproject: collect/write closed without lease; daemon holds barrier", async () => {
  const home = createHome("direct-reproject");
  // Seed one knowledge event under daemon lease so reproject has work to do.
  const seed = await daemonWithHeldProbe(home).run(() => knowledge.appendKnowledgeEvidenceEvent({
    abrainHome: home,
    body: knowledgeBody(9),
  }));
  assert(seed.ok, `seed knowledge=${JSON.stringify(seed)}`);
  const before = canonicalTree(home);
  const settings = { knowledgeProjector: { l2OutputRoot: "repo" } };

  await expectClosed(() => knowledge.reprojectAllKnowledge({ abrainHome: home, settings }), [home]);
  assert(canonicalTree(home) === before, "foreground tracked reproject mutated tree without lease");
  assert(!fs.existsSync(path.join(home, "l2")), "foreground reproject created tracked l2/");

  // State-root reproject remains ungated (no authority surface expansion).
  const stateSettings = { knowledgeProjector: { l2OutputRoot: "state" } };
  const stateResult = await knowledge.reprojectAllKnowledge({ abrainHome: home, settings: stateSettings });
  assert(stateResult.failed === 0, `state reproject failed=${JSON.stringify(stateResult)}`);

  const probe = daemonWithHeldProbe(home);
  const tracked = await probe.run(() => knowledge.reprojectAllKnowledge({ abrainHome: home, settings }));
  assert(tracked.failed === 0 && tracked.projected >= 1, `tracked reproject=${JSON.stringify(tracked)}`);
  assert(probe.state.heldDuringOperation, "tracked reproject missed barrier hold during collect/write");
  assert(fs.existsSync(path.join(home, "l2")), "tracked reproject did not write l2/");
});

fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exit(1);
