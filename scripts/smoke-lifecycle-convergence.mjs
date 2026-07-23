#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-convergence-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-project-"));
const oldRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = root;
const now = new Date("2026-07-23T19:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const lifecycle = await jiti.import(path.join(repoRoot, "extensions/sediment/lifecycle-convergence.ts"));
const lifecycleMetadata = await jiti.import(path.join(repoRoot, "extensions/sediment/lifecycle-source-metadata.ts"));
const proposal = await jiti.import(path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts"));
const multiviewIo = await jiti.import(path.join(repoRoot, "extensions/sediment/multiview-staging-io.ts"));
const ageout = await jiti.import(path.join(repoRoot, "extensions/sediment/staging-ageout.ts"));
const loader = await jiti.import(path.join(repoRoot, "extensions/sediment/staging-loader.ts"));
const replay = await jiti.import(path.join(repoRoot, "extensions/sediment/multiview-staging-replay.ts"));

function isoDaysAgo(days) {
  return new Date(now.getTime() - days * DAY).toISOString();
}

function writeProvisional(slug, created, extra = {}) {
  const entry = {
    slug,
    status: "provisional",
    kind: "provisional-correction",
    created,
    attribution_pending: true,
    originating_device: "smoke",
    hypothesis: `fixture hypothesis ${slug}`,
    source_utterance: [{ quote: `fixture quote ${slug}`, context: "fixture", captured_at: created }],
    suggested_resolution_paths: [],
    _provenance_warning: "fixture",
    ...extra,
  };
  const dir = loader.stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${created.replace(/[:.]/g, "-")}-${slug}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, fixture_envelope: slug, entry }, null, 2)}\n`);
  return file;
}

function writePending(slug, created, state, retryAttempts = 0, extra = {}) {
  const hasPass1 = ["pass2_call_failed", "pass2_unparseable", "deferred", "synthesis_call_failed"].includes(state);
  const hasPass2 = ["deferred", "synthesis_call_failed"].includes(state);
  return multiviewIo.writeMultiviewPending({
    slug,
    status: "provisional",
    kind: "multiview-pending",
    created,
    updated: created,
    origin_project_id: "smoke-project",
    origin_project_root: projectRoot,
    originating_device: "smoke",
    multiview_state: state,
    retry_attempts: retryAttempts,
    last_attempt_iso: created,
    trigger_reason: "forced",
    proposer_decision: { op: "create", rationale: "fixture" },
    proposer_raw_text: "fixture proposer raw",
    candidate_snapshot: { title: `Fixture ${slug}`, kind: "fact", status: "active", confidence: 9, compiledTruth: `fixture full candidate ${slug}` },
    correction_signal: null,
    neighbor_slugs: [],
    ...(hasPass1 ? {
      pass1_verdict: { op: "create", scope: "project", slug_target: null, reasoning: "fixture", raw: "{}" },
    } : {}),
    ...(hasPass2 ? {
      pass2_verdict: { verdict: state === "deferred" ? "defer" : "confirm_pass1", rationale: "fixture", raw: "{}" },
    } : {}),
    ...extra,
  });
}

console.log("Smoke: RM-LIFECYCLE-002 convergence\n");

try {
  await check("new multiview sources are bounded atomically across every creation state", async () => {
    const creationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-creation-"));
    process.env.ABRAIN_ROOT = creationRoot;
    try {
      const states = [
        "reviewer_unavailable",
        "pass1_call_failed",
        "pass1_unparseable",
        "pass2_call_failed",
        "pass2_unparseable",
        "deferred",
        "synthesis_call_failed",
      ];
      const expectedFailure = {
        reviewer_unavailable: "provider",
        pass1_call_failed: "transient",
        pass1_unparseable: "parse",
        pass2_call_failed: "transient",
        pass2_unparseable: "parse",
        deferred: "semantic_defer",
        synthesis_call_failed: "transient",
      };
      const created = now.toISOString();
      const ids = [];
      for (const state of states) {
        const slug = `multiview-immediate-${state}`;
        const file = writePending(slug, created, state);
        const entry = JSON.parse(fs.readFileSync(file, "utf8")).entry;
        const expectedId = `lc-multiview-pending-${sha([created, slug, "smoke"].join("\0")).slice(0, 24)}`;
        assert.equal(entry.lifecycle_item_id, expectedId);
        assert.equal(entry.lifecycle_cohort, "fresh");
        assert.equal(entry.lifecycle_attempt, 0);
        assert.equal(entry.lifecycle_failure_class, expectedFailure[state]);
        assert.ok(Date.parse(entry.lifecycle_next_retry_not_before) > Date.parse(created));
        assert.ok(Date.parse(entry.lifecycle_deadline) > Date.parse(entry.lifecycle_next_retry_not_before));
        assert.ok(entry.lifecycle_new_evidence_trigger);
        assert.equal("next_retry_not_before_iso" in entry, false);
        ids.push(entry.lifecycle_item_id);
      }
      const immediate = lifecycle.rebuildLifecycleConvergence({ abrainHome: creationRoot, now, persist: false });
      assert.equal(immediate.ok, true);
      assert.equal(immediate.read_model.metrics.queues.multiview_pending.pending, states.length);
      assert.equal(immediate.read_model.metrics.unbounded_pending, 0);
      assert.deepEqual(immediate.read_model.rows.map((row) => row.item_id).sort(), [...ids].sort());
      const restartedJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
      const restarted = await restartedJiti.import(path.join(repoRoot, "extensions/sediment/lifecycle-convergence.ts"));
      const afterRestart = restarted.rebuildLifecycleConvergence({ abrainHome: creationRoot, now, persist: false });
      assert.equal(afterRestart.ok, true);
      assert.deepEqual(afterRestart.read_model.rows.map((row) => row.item_id).sort(), [...ids].sort());
    } finally {
      process.env.ABRAIN_ROOT = root;
      fs.rmSync(creationRoot, { recursive: true, force: true });
    }
  });

  await check("unknown multiview state throws and corrupt source fails closed", () => {
    const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-corrupt-state-"));
    process.env.ABRAIN_ROOT = corruptRoot;
    try {
      const file = writePending("multiview-corrupt-state", now.toISOString(), "pass1_call_failed");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      parsed.entry.multiview_state = "unknown_corrupt_state";
      fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
      assert.throws(
        () => lifecycleMetadata.multiviewLifecycleFailureClass(parsed.entry),
        /unknown multiview lifecycle state: unknown_corrupt_state/,
      );
      const model = lifecycle.rebuildLifecycleConvergence({ abrainHome: corruptRoot, now, persist: false });
      assert.equal(model.ok, false);
      assert.equal(model.error, "corrupt_lifecycle_source");
      assert.equal(model.read_model.metrics.source.corrupt_records, 1);
    } finally {
      process.env.ABRAIN_ROOT = root;
      fs.rmSync(corruptRoot, { recursive: true, force: true });
    }
  });

  await check("terminal live residue clears schedules before reversible archive", () => {
    const terminalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-terminal-live-"));
    process.env.ABRAIN_ROOT = terminalRoot;
    try {
      const file = writePending("multiview-terminal-live", isoDaysAgo(1), "pass1_call_failed");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      parsed.entry.lifecycle_terminal_at = now.toISOString();
      parsed.entry.lifecycle_terminal_reason = "fixture_terminal_live";
      parsed.entry.lifecycle_next_retry_not_before = new Date(now.getTime() + DAY).toISOString();
      parsed.entry.lifecycle_deadline = new Date(now.getTime() + 2 * DAY).toISOString();
      parsed.entry.lifecycle_new_evidence_trigger = "stale_pending_schedule";
      fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);

      const reconciled = lifecycle.reconcileStagingLifecycleSources({ abrainHome: terminalRoot, now });
      assert.equal(reconciled.ok, true);
      assert.equal(reconciled.updated, 1);
      const healed = JSON.parse(fs.readFileSync(file, "utf8")).entry;
      assert.equal(healed.lifecycle_terminal_at, now.toISOString());
      assert.equal(healed.lifecycle_terminal_reason, "fixture_terminal_live");
      assert.equal(healed.lifecycle_failure_class, "none");
      assert.equal("lifecycle_next_retry_not_before" in healed, false);
      assert.equal("lifecycle_deadline" in healed, false);
      assert.equal("lifecycle_new_evidence_trigger" in healed, false);
      assert.match(healed.candidate_snapshot.compiledTruth, /fixture full candidate/);

      const swept = lifecycle.sweepMultiviewTerminalEntries({ now });
      assert.equal(swept.already_terminal_archived, 1);
      assert.equal(multiviewIo.loadMultiviewPending().totalFound, 0);
      const abandoned = fs.readdirSync(path.join(loader.stagingDir(), "abandoned"));
      assert.equal(abandoned.length, 1);
      const archived = JSON.parse(fs.readFileSync(path.join(loader.stagingDir(), "abandoned", abandoned[0]), "utf8")).entry;
      assert.match(archived.candidate_snapshot.compiledTruth, /fixture full candidate/);
    } finally {
      process.env.ABRAIN_ROOT = root;
      fs.rmSync(terminalRoot, { recursive: true, force: true });
    }
  });

  await check("multiview replay totalPending includes already-terminal live rows swept before reload", async () => {
    const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-replay-total-"));
    process.env.ABRAIN_ROOT = replayRoot;
    let reviewerCalled = false;
    try {
      writePending("multiview-already-terminal", isoDaysAgo(1), "pass1_call_failed", 0, {
        lifecycle_terminal_at: now.toISOString(),
        lifecycle_terminal_reason: "fixture_terminal_recovery",
        lifecycle_failure_class: "none",
      });
      const result = await replay.replayMultiviewPending({
        settings: {},
        modelRegistry: {},
        currentProjectId: "smoke-project",
        currentProjectRoot: projectRoot,
        loadNeighborsBySlug: async () => { reviewerCalled = true; return []; },
        writeApprovedToBrain: async () => { reviewerCalled = true; },
      });
      assert.equal(result.totalPending, 1);
      assert.equal(result.attempted, 0);
      assert.equal(reviewerCalled, false);
      assert.equal(multiviewIo.loadMultiviewPending().totalFound, 0);
    } finally {
      process.env.ABRAIN_ROOT = root;
      fs.rmSync(replayRoot, { recursive: true, force: true });
    }
  });

  const softFile = writeProvisional("provisional-legacy-soft", isoDaysAgo(45));
  const keepFile = writeProvisional("provisional-fresh-keep", isoDaysAgo(2));
  const providerFile = writeProvisional("provisional-fresh-provider", "2026-07-22T19:00:00+00:00");
  const conflictFile = writeProvisional("provisional-fresh-conflict", isoDaysAgo(1));
  const conflictLiveFile = writeProvisional("provisional-fresh-conflict-live", isoDaysAgo(1));

  const softRaw = JSON.parse(fs.readFileSync(softFile, "utf8")).entry;
  const soft = ageout.annotateAgeOut(softRaw, now, "soft_archive", "fixture terminal");
  fs.writeFileSync(softFile, `${JSON.stringify({ schema_version: 1, entry: soft }, null, 2)}\n`);
  const keepRaw = JSON.parse(fs.readFileSync(keepFile, "utf8")).entry;
  const keep = ageout.annotateAgeOut(keepRaw, now, "keep_aging", "fixture defer");
  fs.writeFileSync(keepFile, `${JSON.stringify({ schema_version: 1, entry: keep }, null, 2)}\n`);

  await check("provisional soft archive is explicit reversible terminal", () => {
    const entry = JSON.parse(fs.readFileSync(softFile, "utf8")).entry;
    assert.equal(entry.lifecycle_state, "soft_archived");
    assert.equal(entry.lifecycle_terminal_reason, "soft_archived");
    assert.ok(entry.lifecycle_terminal_at);
    assert.match(entry.hypothesis, /fixture hypothesis/);
  });

  await check("provider and conflict failures use bounded source backoff", () => {
    const first = lifecycle.recordProvisionalLifecycleFailure([providerFile], "provider", "provider_recovered|resolver_due", now);
    assert.equal(first.updated, 1);
    const firstEntry = JSON.parse(fs.readFileSync(providerFile, "utf8")).entry;
    const firstNext = Date.parse(firstEntry.lifecycle_next_retry_not_before);
    const secondNow = new Date(now.getTime() + 1000);
    const second = lifecycle.recordProvisionalLifecycleFailure([providerFile], "provider", "provider_recovered|resolver_due", secondNow);
    assert.equal(second.updated, 1);
    const secondEntry = JSON.parse(fs.readFileSync(providerFile, "utf8")).entry;
    const secondNext = Date.parse(secondEntry.lifecycle_next_retry_not_before);
    assert.equal(secondEntry.lifecycle_attempt, 2);
    assert.equal(secondEntry.lifecycle_failure_class, "provider");
    assert.equal(secondEntry.lifecycle_item_id, `lc-provisional-correction-${sha(["2026-07-22T19:00:00.000Z", "provisional-fresh-provider", "smoke"].join("\0")).slice(0, 24)}`);
    const providerEnvelope = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    assert.equal(providerEnvelope.schema_version, 1);
    assert.equal(providerEnvelope.fixture_envelope, "provisional-fresh-provider");
    assert.ok(secondNext > firstNext);
    assert.ok(secondNext - secondNow.getTime() <= DAY);
    assert.ok(Date.parse(secondEntry.lifecycle_deadline) > secondNext);
    const conflict = lifecycle.recordProvisionalLifecycleFailure([conflictFile], "conflict", "conflict_evidence_changed|resolver_due", now);
    assert.equal(conflict.updated, 1);
    const conflictEntry = JSON.parse(fs.readFileSync(conflictFile, "utf8")).entry;
    assert.equal(conflictEntry.lifecycle_failure_class, "conflict");
    assert.ok(Date.parse(conflictEntry.lifecycle_next_retry_not_before) - now.getTime() <= DAY);
    lifecycle.recordProvisionalLifecycleFailure([conflictLiveFile], "conflict", "conflict_evidence_changed|resolver_due", now);
  });

  await check("provisional deadline expiry writes a reversible terminal source state", () => {
    const parsed = JSON.parse(fs.readFileSync(conflictFile, "utf8"));
    parsed.entry.lifecycle_next_retry_not_before = isoDaysAgo(2);
    parsed.entry.lifecycle_deadline = isoDaysAgo(1);
    fs.writeFileSync(conflictFile, `${JSON.stringify(parsed, null, 2)}\n`);
    const reconciled = lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now });
    const terminal = JSON.parse(fs.readFileSync(conflictFile, "utf8"));
    assert.equal(reconciled.deadline_terminal, 1);
    assert.equal(reconciled.provisional_deadline_terminal, 1);
    assert.equal(terminal.entry.lifecycle_state, "soft_archived");
    assert.equal(terminal.entry.lifecycle_terminal_reason, "provisional_deadline_expired");
    assert.match(terminal.entry.hypothesis, /fixture hypothesis/);
    assert.equal(terminal.fixture_envelope, "provisional-fresh-conflict");
  });

  writePending("multiview-stale", isoDaysAgo(15), "pass1_call_failed", 0);
  writePending("multiview-retry-cap", isoDaysAgo(2), "deferred", 3);
  writePending("multiview-fresh-pending", isoDaysAgo(1), "pass1_unparseable", 0);

  await check("global multiview sweep terminals stale and retry-cap across owners", () => {
    const swept = lifecycle.sweepMultiviewTerminalEntries({ now });
    assert.equal(swept.ok, true);
    assert.equal(swept.terminal, 2);
    assert.equal(swept.stale, 0);
    assert.equal(swept.deadline_expired, 1);
    assert.equal(swept.retry_cap, 1);
    const live = multiviewIo.loadMultiviewPending().entries;
    assert.deepEqual(live.map((entry) => entry.slug), ["multiview-fresh-pending"]);
    const abandonedDir = path.join(loader.stagingDir(), "abandoned");
    const abandoned = fs.readdirSync(abandonedDir).filter((name) => name.endsWith(".json"));
    assert.equal(abandoned.length, 2);
    for (const name of abandoned) {
      const entry = JSON.parse(fs.readFileSync(path.join(abandonedDir, name), "utf8")).entry;
      assert.ok(entry.lifecycle_terminal_at);
      assert.match(entry.lifecycle_terminal_reason, /^multiview_/);
      assert.match(entry.candidate_snapshot.compiledTruth, /fixture full candidate/);
    }
    const replay = lifecycle.sweepMultiviewTerminalEntries({ now });
    assert.equal(replay.terminal, 0);
    assert.equal(replay.archive_failed, 0);
  });

  const proposalFile = proposal.entryLifecycleProposalsPath();
  fs.mkdirSync(path.dirname(proposalFile), { recursive: true });
  const legacyE2 = {
    schema_version: 1,
    ts: isoDaysAgo(10),
    project_root: path.resolve(projectRoot),
    slug: "e2-migrate-successor",
    kind: "fact",
    op: "archive",
    reason: "superseded_no_successor",
    independent_evidence: "fixture",
    falsifier: "fixture",
    expected_status: "superseded",
    disposition: "review_required",
    evidence_source: "frontmatter_superseded",
    evidence_key: "E2:e2-migrate-successor:no_successor",
    review_required: true,
    status: "pending",
  };
  fs.writeFileSync(proposalFile, `${JSON.stringify(legacyE2)}\n`);

  await check("historical raw E2 migrates without a live review_required semantic", () => {
    const migrated = proposal.reconcileLifecycleProposalDeferrals({ now });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.migrated_e2, 1);
    const raw = fs.readFileSync(proposalFile, "utf8");
    assert.equal(raw.includes("review_required"), false);
    const row = proposal.readLifecycleProposals(projectRoot)[0];
    assert.equal(row.status, "deferred_until_new_evidence");
    assert.equal(row.failure_class, "semantic_defer");
    assert.equal(row.new_evidence_trigger, "new_valid_successor_edge|status_no_longer_superseded|independent_attributed_evidence");
    assert.ok(Date.parse(row.next_retry_not_before) > now.getTime());
    assert.ok(Date.parse(row.deadline) > Date.parse(row.next_retry_not_before));
  });

  await check("successor discovery terminals E2 and automatically opens E1", () => {
    proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now,
      entries: [{
        slug: "e2-migrate-successor",
        kind: "fact",
        status: "superseded",
        frontmatter: { status: "superseded", superseded_by: ["successor"] },
        relations: [{ type: "superseded_by", to: "successor" }],
      }],
    });
    const rows = proposal.readLifecycleProposals(projectRoot).filter((row) => row.slug === "e2-migrate-successor");
    const e2 = rows.find((row) => row.reason === "superseded_no_successor");
    const e1 = rows.find((row) => row.reason === "affirm_superseded");
    assert.equal(e2.status, "failed");
    assert.equal(e2.terminal_reason, "successor_edge_observed");
    assert.equal(e1.status, "pending");
    assert.equal(e1.disposition, "execution_ready");
    assert.equal(e1.supersedes_proposal_id, e2.proposal_id);
  });

  await check("status restoration terminals E2 without a human queue", () => {
    proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now,
      entries: [{ slug: "e2-status-restored", kind: "decision", status: "superseded", frontmatter: { status: "superseded" }, relations: [] }],
    });
    proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now: new Date(now.getTime() + 1000),
      entries: [{ slug: "e2-status-restored", kind: "decision", status: "active", frontmatter: { status: "active" }, relations: [] }],
    });
    const row = proposal.readLifecycleProposals(projectRoot).find((item) => item.slug === "e2-status-restored");
    assert.equal(row.status, "failed");
    assert.equal(row.terminal_reason, "status_no_longer_superseded");
    assert.ok(row.terminal_at);
  });

  await check("independent attributed evidence reopens E2 for autonomous execution", () => {
    const slug = "e2-independent-evidence";
    proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now,
      entries: [{ slug, kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] }],
    });
    const eventId = sha("fixture-independent-attributed-evidence");
    const indexFile = path.join(root, ".state", "sediment", "outcome-evidence-index.jsonl");
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, `${JSON.stringify({
      schema_version: "outcome-evidence-index/v1",
      event_id: eventId,
      event_type: "action_outcome_observed",
      created_at_utc: new Date(now.getTime() + 2_000).toISOString(),
      session_id: "fixture-session",
      turn_id: "fixture-turn",
      project_root_hash: sha(path.resolve(projectRoot)),
      causal_parents: [],
      observation_kind: "test",
      terminal_status: "passed",
      attribution_status: "attributed",
      memory_entry_slugs: [slug],
      exposure_event_ids: [],
      candidate_exposure_event_ids: [],
      evidence_independence: "independent_execution",
      evidence_strength: "high",
    })}\n`);
    const reopened = proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now: new Date(now.getTime() + 3_000),
      entries: [{ slug, kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] }],
    });
    const row = proposal.readLifecycleProposals(projectRoot).find((item) => item.slug === slug);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.written, true);
    assert.equal(row.status, "pending");
    assert.equal(row.disposition, "execution_ready");
    assert.equal(row.failure_class, "transient");
    assert.deepEqual(row.independent_evidence_event_ids, [eventId]);
    assert.match(row.message, /reopened_by_independent_attributed_evidence/);
    const replay = proposal.appendSupersededFrontmatterProposals({
      projectRoot,
      now: new Date(now.getTime() + 4_000),
      entries: [{ slug, kind: "fact", status: "superseded", frontmatter: { status: "superseded" }, relations: [] }],
    });
    assert.equal(replay.written, false);
    assert.equal(proposal.readLifecycleProposals(projectRoot).find((item) => item.slug === slug).status, "pending");
  });

  await check("creation-time bounds make source reconciliation immediately idempotent", () => {
    const first = lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now });
    assert.equal(first.ok, true);
    assert.equal(first.updated, 0);
    const mirrored = multiviewIo.loadMultiviewPending().entries.find((entry) => entry.slug === "multiview-fresh-pending");
    assert.ok(mirrored.lifecycle_next_retry_not_before);
    assert.equal("next_retry_not_before_iso" in mirrored, false);
    const second = lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now });
    assert.equal(second.ok, true);
    assert.equal(second.updated, 0);
  });

  await check("deadline expiry performs autonomous reversible source actions at +1d and +7d", () => {
    const writerDecision = { op: "create", scope: "project", zone: "memory", rationale: "fixture deadline" };
    writePending("multiview-writer-deadline-1d", isoDaysAgo(1), "pass1_call_failed", 0, {
      approved_decision: writerDecision,
      approved_at_iso: now.toISOString(),
      writer_retry_attempts: 1,
      lifecycle_failure_class: "writer",
      lifecycle_next_retry_not_before: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      lifecycle_deadline: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
      lifecycle_new_evidence_trigger: "writer_or_storage_recovered|retry_due",
    });
    writePending("multiview-writer-deadline-7d", isoDaysAgo(1), "pass1_call_failed", 0, {
      approved_decision: writerDecision,
      approved_at_iso: now.toISOString(),
      writer_retry_attempts: 1,
      lifecycle_failure_class: "writer",
      lifecycle_next_retry_not_before: new Date(now.getTime() + DAY).toISOString(),
      lifecycle_deadline: new Date(now.getTime() + 6 * DAY).toISOString(),
      lifecycle_new_evidence_trigger: "writer_or_storage_recovered|retry_due",
    });

    const plus1d = new Date(now.getTime() + DAY);
    const firstSweep = lifecycle.sweepMultiviewTerminalEntries({ now: plus1d });
    assert.equal(firstSweep.deadline_expired, 1);
    assert.equal(firstSweep.terminal, 1);
    const firstProposalSweep = proposal.reconcileLifecycleProposalDeferrals({ now: plus1d });
    assert.equal(firstProposalSweep.ok, true);
    lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now: plus1d });
    const firstModel = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now: plus1d, persist: false });
    assert.equal(firstModel.ok, true);
    assert.equal(firstModel.read_model.metrics.unbounded_pending, 0);

    const plus7d = new Date(now.getTime() + 7 * DAY);
    const secondSweep = lifecycle.sweepMultiviewTerminalEntries({ now: plus7d });
    assert.equal(secondSweep.deadline_expired, 1);
    assert.equal(secondSweep.terminal, 1);
    const proposalSweep = proposal.reconcileLifecycleProposalDeferrals({ now: plus7d });
    assert.equal(proposalSweep.ok, true);
    assert.ok(firstProposalSweep.bounded_retry_scheduled + proposalSweep.bounded_retry_scheduled > 0);
    const retriedE1 = proposal.readLifecycleProposals(projectRoot).find((row) => row.slug === "e2-migrate-successor" && row.reason === "affirm_superseded");
    assert.equal(retriedE1.status, "pending");
    assert.equal(retriedE1.attempt, 2);
    assert.ok(Date.parse(retriedE1.next_retry_not_before) > plus7d.getTime());
    assert.ok(Date.parse(retriedE1.deadline) > Date.parse(retriedE1.next_retry_not_before));
    const sourceSweep = lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now: plus7d });
    assert.equal(sourceSweep.ok, true);
    const secondModel = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now: plus7d, persist: false });
    assert.equal(secondModel.ok, true);
    assert.equal(secondModel.read_model.metrics.unbounded_pending, 0);

    const abandonedDir = path.join(loader.stagingDir(), "abandoned");
    const deadlineEntries = fs.readdirSync(abandonedDir)
      .filter((name) => name.includes("multiview-writer-deadline-") && name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(abandonedDir, name), "utf8")).entry);
    assert.equal(deadlineEntries.length, 2);
    assert.equal(deadlineEntries.every((entry) => entry.lifecycle_terminal_reason === "multiview_deadline_expired"), true);
    assert.equal(deadlineEntries.every((entry) => /fixture full candidate/.test(entry.candidate_snapshot.compiledTruth)), true);
  });

  let persistedHash;
  let stableIds;
  await check("unified read model conserves arrivals and has no unbounded pending", () => {
    proposal.reconcileLifecycleProposalDeferrals({ now });
    const first = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(first.ok, true);
    assert.equal(first.written, true);
    const model = first.read_model;
    assert.equal(model.metrics.continuity_baseline, "bootstrap_no_previous_model");
    assert.equal(model.metrics.continuity_holds, true);
    assert.deepEqual(model.metrics.missing_previous_item_ids, []);
    assert.equal(model.metrics.conservation.holds, true);
    assert.equal(model.metrics.cohorts.legacy.conservation_holds, true);
    assert.equal(model.metrics.cohorts.fresh.conservation_holds, true);
    assert.equal(model.metrics.arrivals, model.metrics.terminal + model.metrics.pending);
    assert.equal(model.metrics.unbounded_pending, 0);
    assert.ok(model.metrics.retry_count > 0);
    assert.ok(model.metrics.cohorts.legacy.arrivals > 0);
    assert.ok(model.metrics.cohorts.fresh.arrivals > 0);
    assert.ok(model.metrics.oldest_pending_age_days > 0);
    assert.ok(model.metrics.oldest_fresh_pending_age_days > 0);
    assert.equal(model.metrics.failure_classes.provider > 0, true);
    assert.equal(model.metrics.failure_classes.parse > 0, true);
    assert.equal(model.metrics.failure_classes.conflict > 0, true);
    stableIds = model.rows.map((row) => row.item_id);
    assert.equal(new Set(stableIds).size, stableIds.length);
    const proposalReplay = proposal.reconcileLifecycleProposalDeferrals({ now });
    assert.equal(proposalReplay.written, false);
    assert.equal(proposalReplay.migrated_e2, 0);
    assert.equal(proposalReplay.scheduled_nonterminal, 0);
    const second = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(second.ok, true);
    assert.equal(second.written, true);
    assert.equal(second.read_model.metrics.continuity_baseline, "persisted_read_model");
    assert.equal(second.read_model.metrics.previous_item_count, stableIds.length);
    assert.deepEqual(second.read_model.rows.map((row) => row.item_id), stableIds);
    const third = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(third.ok, true);
    assert.equal(third.written, false);
    persistedHash = sha(fs.readFileSync(lifecycle.lifecycleConvergencePath(root)));
  });

  await check("live to abandoned terminal move preserves item_id continuity", () => {
    writePending("multiview-continuity-terminal-move", isoDaysAgo(1), "pass1_call_failed", 0);
    lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now });
    const withLive = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(withLive.ok, true);
    const liveRow = withLive.read_model.rows.find((row) => row.current_state === "pending_replay" && !stableIds.includes(row.item_id));
    assert.ok(liveRow);
    assert.equal(multiviewIo.archiveMultiviewPending("multiview-continuity-terminal-move", { terminalAt: now.toISOString(), terminalReason: "fixture_terminal_move" }), true);
    lifecycle.reconcileStagingLifecycleSources({ abrainHome: root, now });
    const moved = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(moved.ok, true);
    assert.equal(moved.read_model.metrics.continuity_holds, true);
    assert.deepEqual(moved.read_model.metrics.missing_previous_item_ids, []);
    const terminalRow = moved.read_model.rows.find((row) => row.item_id === liveRow.item_id);
    assert.equal(terminalRow.current_state, "terminal_abandoned");
    stableIds = moved.read_model.rows.map((row) => row.item_id);
    persistedHash = sha(fs.readFileSync(lifecycle.lifecycleConvergencePath(root)));
  });

  await check("read-model projection never invents missing schedule or terminal evidence", () => {
    const clean = fs.readFileSync(proposalFile, "utf8");
    const rows = clean.trim().split("\n").map((line) => JSON.parse(line));
    const pendingIndex = rows.findIndex((row) => row.status !== "failed" && row.status !== "executed");
    assert.ok(pendingIndex >= 0);
    delete rows[pendingIndex].next_retry_not_before;
    delete rows[pendingIndex].deadline;
    delete rows[pendingIndex].new_evidence_trigger;
    fs.writeFileSync(proposalFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const unbounded = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now, persist: false });
    assert.equal(unbounded.ok, true);
    assert.ok(unbounded.read_model.metrics.unbounded_pending > 0);
    const terminalIndex = rows.findIndex((row) => row.status === "failed" || row.status === "executed");
    assert.ok(terminalIndex >= 0);
    delete rows[terminalIndex].terminal_at;
    fs.writeFileSync(proposalFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const missingTerminal = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now, persist: false });
    assert.equal(missingTerminal.ok, false);
    assert.equal(missingTerminal.error, "corrupt_lifecycle_source");
    fs.writeFileSync(proposalFile, clean);
  });

  await check("missing prior item_id fails closed and preserves the last-good read model", () => {
    const sourceBytes = fs.readFileSync(providerFile);
    const sourceEntry = JSON.parse(sourceBytes.toString("utf8")).entry;
    fs.rmSync(providerFile);
    const missing = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(missing.ok, false);
    assert.equal(missing.written, false);
    assert.equal(missing.error, "lifecycle_item_continuity_broken");
    assert.equal(missing.read_model.metrics.continuity_holds, false);
    assert.deepEqual(missing.read_model.metrics.missing_previous_item_ids, [sourceEntry.lifecycle_item_id]);
    assert.equal(missing.read_model.metrics.conservation.holds, false);
    assert.equal(sha(fs.readFileSync(lifecycle.lifecycleConvergencePath(root))), persistedHash);
    fs.writeFileSync(providerFile, sourceBytes);
    const restored = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(restored.ok, true);
    assert.equal(restored.written, false);
  });

  await check("corrupt source fails closed and preserves both source and prior read model", () => {
    const clean = fs.readFileSync(proposalFile, "utf8");
    fs.appendFileSync(proposalFile, "{not valid json\n");
    const corruptHash = sha(fs.readFileSync(proposalFile));
    const reconcile = proposal.reconcileLifecycleProposalDeferrals({ now });
    assert.equal(reconcile.ok, false);
    assert.equal(reconcile.error, "proposal_jsonl_parse_failed");
    assert.equal(sha(fs.readFileSync(proposalFile)), corruptHash);
    const result = lifecycle.rebuildLifecycleConvergence({ abrainHome: root, now });
    assert.equal(result.ok, false);
    assert.equal(result.error, "corrupt_lifecycle_source");
    assert.equal(sha(fs.readFileSync(lifecycle.lifecycleConvergencePath(root))), persistedHash);
    fs.writeFileSync(proposalFile, clean);
  });

  await check("fresh module restart reads the same stable IDs and metrics", async () => {
    const restartedJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const restarted = await restartedJiti.import(path.join(repoRoot, "extensions/sediment/lifecycle-convergence.ts"));
    const model = restarted.readLifecycleConvergence(root);
    assert.ok(model);
    assert.deepEqual(model.rows.map((row) => row.item_id), stableIds);
    assert.equal(model.metrics.unbounded_pending, 0);
    assert.equal(model.metrics.conservation.holds, true);
  });

  await check("proposal row-cap state is visible in read-model telemetry and overflow fails closed", () => {
    const capRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-lifecycle-cap-"));
    try {
      const capFile = path.join(capRoot, ".state", "sediment", "entry-lifecycle-proposals.jsonl");
      fs.mkdirSync(path.dirname(capFile), { recursive: true });
      const row = (index) => ({
        schema_version: 1,
        ts: now.toISOString(),
        project_root: projectRoot,
        slug: `cap-${index}`,
        kind: "fact",
        op: "archive",
        reason: "affirm_stale",
        independent_evidence: "fixture",
        falsifier: "fixture",
        evidence_source: "frontmatter_superseded",
        proposal_id: `cap-proposal-${index}`,
        status: "failed",
        terminal_at: now.toISOString(),
        terminal_reason: "fixture_terminal",
      });
      const rows = Array.from({ length: 1000 }, (_, index) => row(index));
      fs.writeFileSync(capFile, `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`);
      const atCap = lifecycle.rebuildLifecycleConvergence({ abrainHome: capRoot, now, persist: false });
      assert.equal(atCap.ok, true);
      assert.equal(atCap.read_model.metrics.source.proposal_rows, 1000);
      assert.equal(atCap.read_model.metrics.source.proposal_row_limit_reached, true);
      fs.appendFileSync(capFile, `${JSON.stringify(row(1000))}\n`);
      const overflow = lifecycle.rebuildLifecycleConvergence({ abrainHome: capRoot, now, persist: false });
      assert.equal(overflow.ok, false);
      assert.equal(overflow.error, "lifecycle_proposal_row_limit_exceeded");
      assert.equal(overflow.read_model.metrics.source.proposal_rows, 1001);
      assert.equal(overflow.read_model.metrics.source.proposal_row_limit_reached, true);
    } finally {
      fs.rmSync(capRoot, { recursive: true, force: true });
    }
  });

  await check("no contested/Lane-G trigger invents a pipeline or a human queue", () => {
    const model = lifecycle.readLifecycleConvergence(root);
    assert.equal(model.rows.some((row) => row.current_state.includes("contested")), false);
    assert.deepEqual([...new Set(model.rows.map((row) => row.queue_kind))].sort(), ["entry_lifecycle_proposal", "multiview_pending", "provisional_correction"]);
    const sources = [
      "extensions/sediment/lifecycle-convergence.ts",
      "extensions/sediment/multiview-staging-replay.ts",
      "extensions/sediment/entry-lifecycle-proposals.ts",
    ].map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
    assert.equal(/human[_ -]review|operator[_ -]queue/i.test(sources), false);
  });

  await check("RM lifecycle staging paths contain no physical delete primitive", () => {
    for (const file of ["extensions/sediment/staging-loader.ts", "extensions/sediment/multiview-staging-io.ts", "extensions/sediment/multiview-staging-replay.ts"]) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      assert.equal(/fs\.unlinkSync\(/.test(source), false, file);
    }
  });

  console.log(`\nPASS ${passed}`);
} finally {
  if (oldRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = oldRoot;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}
