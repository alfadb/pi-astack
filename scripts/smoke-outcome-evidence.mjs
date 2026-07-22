#!/usr/bin/env node
/** RM-OUTCOME-001 L1 outcome evidence spine smoke. */
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
const outcome = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack || error}`);
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-outcome-evidence-"));
const abrainHome = path.join(root, "abrain");
const projectRoot = path.join(root, "project");
fs.mkdirSync(abrainHome, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });

const toolCall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistantCalls = (calls) => ({ role: "assistant", content: calls });
const toolResult = (id, name, content, details = undefined, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content,
  ...(details ? { details } : {}),
  isError,
  timestamp: "2026-07-22T12:00:00.000Z",
});

const calls = [
  toolCall("mem-1", "memory_search", { query: "joined memory" }),
  toolCall("test-1", "bash", { command: "npm test" }),
  toolCall("lint-1", "bash", { command: "npm run lint" }),
  toolCall("build-1", "bash", { command: "npm run build" }),
  toolCall("revert-1", "bash", { command: "git revert deadbeef" }),
  toolCall("rewrite-1", "bash", { command: "git rebase main" }),
  toolCall("workflow-1", "workflow_run", { workflow: "verify" }),
  toolCall("structured-1", "dispatch_agent", { task: "verify" }),
  toolCall("ordinary-1", "read", { path: "README.md" }),
];
const results = [
  toolResult("mem-1", "memory_search", JSON.stringify({ results: [{ slug: "joined-memory" }] })),
  toolResult("test-1", "bash", "test output must remain hash-only", { exitCode: 0 }),
  toolResult("lint-1", "bash", "lint output", { exitCode: 1 }, true),
  toolResult("build-1", "bash", "build output", { exitCode: 0 }),
  toolResult("revert-1", "bash", "revert output", { exitCode: 0 }),
  toolResult("rewrite-1", "bash", "rewrite output", { exitCode: 0 }),
  toolResult("workflow-1", "workflow_run", "workflow complete", { terminalState: "completed" }),
  toolResult("structured-1", "dispatch_agent", "dispatch complete", { kind: "dispatch_result", terminalState: "completed" }),
  toolResult("ordinary-1", "read", "ordinary successful tool result", { ok: true }),
];
const branch = [
  assistantCalls(calls),
  ...results,
  { role: "assistant", content: "Used the retrieved entry.\n\n```memory-footnote\nslug: joined-memory\n```" },
];

let first;
await check("collector writes exposure, independent source coverage, outcome, and rejudge joins", async () => {
  first = await outcome.collectAndAppendOutcomeEvidence({ abrainHome, projectRoot, sessionId: "session-a", turnId: "1", branch });
  assert(first.errors.length === 0, JSON.stringify(first));
  assert(first.exposures.length === 1, JSON.stringify(first));
  assert(first.outcomes.length === 7, `ordinary tool must be skipped; got ${JSON.stringify(first)}`);
  assert(first.rejudges.length === first.outcomes.length, JSON.stringify(first));
  const rows = outcome.readOutcomeEvidenceIndex(abrainHome);
  const observed = new Set(rows.filter((row) => row.event_type === "action_outcome_observed").map((row) => row.observation_kind));
  for (const kind of ["test", "lint", "build", "git_revert", "git_rewrite", "workflow", "tool"]) assert(observed.has(kind), `missing ${kind}`);
  const joined = rows.filter((row) => first.outcomes.includes(row.event_id));
  assert(joined.every((row) => row.attribution_status === "corroborated" && row.memory_entry_slugs.includes("joined-memory") && row.exposure_event_ids.length === 1), "joined outcome attribution drift");
});

await check("schema registry and outcome body validator fail closed", async () => {
  const scan = await l1.scanWholeL1Validated({ abrainHome });
  const records = scan.all.filter((record) => record.registration.envelope_schema === outcome.OUTCOME_EVIDENCE_ENVELOPE_SCHEMA);
  assert(records.length === first.exposures.length + first.outcomes.length + first.rejudges.length, "registry scan count mismatch");
  const file = outcome.outcomeEvidenceEventPath(abrainHome, first.outcomes[0]);
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(outcome.validateOutcomeEvidenceEnvelope(envelope).ok, "valid outcome envelope rejected");
  const bad = JSON.parse(JSON.stringify(envelope));
  bad.body.evidence.independence = "self_report";
  bad.event_id = bad.body_hash = jcs.jcsSha256Hex(bad.body);
  const invalid = outcome.validateOutcomeEvidenceEnvelope(bad);
  assert(!invalid.ok && invalid.error === "event_independence_mismatch", JSON.stringify(invalid));
  assert(fs.readFileSync(file, "utf8") === `${jcs.canonicalizeJcs(envelope)}\n`, "L1 bytes are not RFC8785-JCS plus LF");
});

await check("unknown attribution forbids verified exposure ids and claimed targets need limitation", async () => {
  const file = outcome.outcomeEvidenceEventPath(abrainHome, first.outcomes[0]);
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const noJoin = JSON.parse(JSON.stringify(envelope));
  noJoin.body.attribution = {
    status: "unknown",
    basis: "no_reliable_join",
    memory_entry_slugs: [],
    exposure_event_ids: envelope.body.attribution.exposure_event_ids,
    candidate_exposure_event_ids: [],
    limitations: ["x"],
  };
  noJoin.event_id = noJoin.body_hash = jcs.jcsSha256Hex(noJoin.body);
  const rejectedJoin = outcome.validateOutcomeEvidenceEnvelope(noJoin);
  assert(!rejectedJoin.ok && rejectedJoin.error === "unknown_attribution_has_join", JSON.stringify(rejectedJoin));

  const claimedNoLimit = JSON.parse(JSON.stringify(envelope));
  claimedNoLimit.body.attribution = {
    status: "unknown",
    basis: "no_reliable_join",
    memory_entry_slugs: ["user-claimed-slug"],
    exposure_event_ids: [],
    candidate_exposure_event_ids: [],
    limitations: [],
  };
  claimedNoLimit.event_id = claimedNoLimit.body_hash = jcs.jcsSha256Hex(claimedNoLimit.body);
  const rejectedClaim = outcome.validateOutcomeEvidenceEnvelope(claimedNoLimit);
  assert(!rejectedClaim.ok && rejectedClaim.error === "unknown_attribution_claimed_targets_need_limitation", JSON.stringify(rejectedClaim));

  const claimedWithLimit = JSON.parse(JSON.stringify(envelope));
  claimedWithLimit.body.attribution = {
    status: "unknown",
    basis: "no_reliable_join",
    memory_entry_slugs: ["user-claimed-slug"],
    exposure_event_ids: [],
    candidate_exposure_event_ids: [],
    limitations: ["user-claimed only; not reliable lifecycle attribution"],
  };
  claimedWithLimit.event_id = claimedWithLimit.body_hash = jcs.jcsSha256Hex(claimedWithLimit.body);
  assert(outcome.validateOutcomeEvidenceEnvelope(claimedWithLimit).ok, "unknown claimed target with limitation must validate");
});

await check("duplicate collection and restart rebuild are idempotent", async () => {
  const replay = await outcome.collectAndAppendOutcomeEvidence({ abrainHome, projectRoot, sessionId: "session-a", turnId: "1", branch });
  assert(JSON.stringify(replay.exposures) === JSON.stringify(first.exposures), "exposure IDs changed on replay");
  assert(JSON.stringify(replay.outcomes) === JSON.stringify(first.outcomes), "outcome IDs changed on replay");
  assert(JSON.stringify(replay.rejudges) === JSON.stringify(first.rejudges), "rejudge IDs changed on replay");
  const before = outcome.readOutcomeEvidenceIndex(abrainHome);
  fs.rmSync(outcome.outcomeEvidenceIndexPath(abrainHome));
  const rebuilt = outcome.rebuildOutcomeEvidenceIndex(abrainHome);
  const after = outcome.readOutcomeEvidenceIndex(abrainHome);
  assert(rebuilt.ok && rebuilt.rows === before.length, JSON.stringify(rebuilt));
  assert(JSON.stringify(after) === JSON.stringify(before), "restart rebuild changed derived index");
});

await check("index rebuild rejects foreign/invalid per-file but keeps legal outcomes", async () => {
  const foreignId = "ff".repeat(32);
  const foreignPath = path.join(abrainHome, "l1", "events", "sha256", foreignId.slice(0, 2), foreignId.slice(2, 4), `${foreignId}.json`);
  fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
  fs.writeFileSync(foreignPath, `${JSON.stringify({ schema: "knowledge-evidence-envelope/v1", event_id: foreignId, body_hash: foreignId, body: {} })}\n`);

  const badId = "aa".repeat(32);
  const badPath = path.join(abrainHome, "l1", "events", "sha256", badId.slice(0, 2), badId.slice(2, 4), `${badId}.json`);
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, `${JSON.stringify({
    schema: outcome.OUTCOME_EVIDENCE_ENVELOPE_SCHEMA,
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: badId,
    body_hash: badId,
    body: { event_schema_version: outcome.OUTCOME_EVIDENCE_BODY_SCHEMA, event_type: "action_outcome_observed" },
  })}\n`);

  const rebuilt = outcome.rebuildOutcomeEvidenceIndex(abrainHome);
  assert(rebuilt.ok, `rebuild failed closed on foreign/invalid: ${JSON.stringify(rebuilt)}`);
  assert(rebuilt.rows >= first.exposures.length + first.outcomes.length + first.rejudges.length, JSON.stringify(rebuilt));
  assert(rebuilt.diagnostics.some((line) => line.includes("foreign_schema")), `missing foreign diagnostic: ${JSON.stringify(rebuilt.diagnostics)}`);
  assert(rebuilt.diagnostics.some((line) => line.includes("outcome_invalid")), `missing invalid diagnostic: ${JSON.stringify(rebuilt.diagnostics)}`);
  const rows = outcome.readOutcomeEvidenceIndex(abrainHome);
  assert(rows.some((row) => row.event_id === first.outcomes[0]), "legal outcome missing after foreign/invalid neighbor");
  assert(!rows.some((row) => row.event_id === foreignId || row.event_id === badId), "foreign/invalid rows must not enter index");
});

await check("unknown attribution remains explicit and does not fabricate a memory join", async () => {
  const unknownBranch = [
    assistantCalls([toolCall("unknown-1", "bash", { command: "npm test" })]),
    toolResult("unknown-1", "bash", "unknown attribution", { exitCode: 0 }),
  ];
  const result = await outcome.collectAndAppendOutcomeEvidence({ abrainHome, projectRoot, sessionId: "session-b", turnId: "2", branch: unknownBranch });
  assert(result.outcomes.length === 1 && result.rejudges.length === 1, JSON.stringify(result));
  const rows = outcome.readOutcomeEvidenceIndex(abrainHome);
  const observed = rows.find((row) => row.event_id === result.outcomes[0]);
  const rejudge = rows.find((row) => row.event_id === result.rejudges[0]);
  assert(observed?.attribution_status === "unknown" && observed.memory_entry_slugs.length === 0 && observed.exposure_event_ids.length === 0, JSON.stringify(observed));
  assert(rejudge?.rejudge_decision === "defer_until_new_evidence", JSON.stringify(rejudge));
});

await check("substring-only bash commands never produce independent outcomes", async () => {
  const negativeBranch = [
    assistantCalls([
      toolCall("echo-1", "bash", { command: 'echo "git revert"' }),
      toolCall("grep-1", "bash", { command: "grep eslint" }),
      toolCall("log-1", "bash", { command: 'git log --grep="npm test"' }),
      toolCall("chain-1", "bash", { command: "npm test && echo done" }),
    ]),
    toolResult("echo-1", "bash", "echoed", { exitCode: 0 }),
    toolResult("grep-1", "bash", "matched", { exitCode: 0 }),
    toolResult("log-1", "bash", "log", { exitCode: 0 }),
    toolResult("chain-1", "bash", "chained", { exitCode: 0 }),
  ];
  const before = outcome.readOutcomeEvidenceIndex(abrainHome).filter((row) => row.event_type === "action_outcome_observed").length;
  const result = await outcome.collectAndAppendOutcomeEvidence({ abrainHome, projectRoot, sessionId: "session-neg", turnId: "9", branch: negativeBranch });
  assert(result.outcomes.length === 0 && result.rejudges.length === 0, JSON.stringify(result));
  const after = outcome.readOutcomeEvidenceIndex(abrainHome).filter((row) => row.event_type === "action_outcome_observed").length;
  assert(after === before, "negative commands polluted outcome index");
});

await check("footnote, exposure, silence, and ordinary tool success have no independent authority", async () => {
  const weakBranch = [
    assistantCalls([toolCall("mem-weak", "memory_get", { slug: "weak-memory" }), toolCall("read-weak", "read", { path: "README.md" })]),
    toolResult("mem-weak", "memory_get", JSON.stringify({ slug: "weak-memory" })),
    toolResult("read-weak", "read", "ordinary output", { ok: true }),
    { role: "assistant", content: "```memory-footnote\nslug: weak-memory\n```" },
  ];
  const result = await outcome.collectAndAppendOutcomeEvidence({ abrainHome, projectRoot, sessionId: "session-c", turnId: "3", branch: weakBranch });
  assert(result.exposures.length === 1 && result.outcomes.length === 0 && result.rejudges.length === 0, JSON.stringify(result));
  assert(outcome.resolveIndependentOutcomeEvidenceEventIds(result.exposures, projectRoot, { abrainHome }).length === 0, "exposure gained independent authority");
});

await check("user-authored natural correction is independent but unknown without a reliable target join", async () => {
  const result = await outcome.appendNaturalCorrectionOutcomeEvidence({
    abrainHome,
    projectRoot,
    sessionId: "session-natural",
    turnId: "4",
    userQuote: "That instruction was wrong; use the corrected command.",
    provenance: "user-expressed",
    targetSlug: null,
    createdAt: "2026-07-22T12:05:00.000Z",
  });
  assert(result.correction && result.rejudge && result.status === "unknown", JSON.stringify(result));
  const rows = outcome.readOutcomeEvidenceIndex(abrainHome);
  const correction = rows.find((row) => row.event_id === result.correction);
  assert(correction?.evidence_independence === "user_authored" && correction.attribution_status === "unknown", JSON.stringify(correction));
});

await check("resolver requires attributed (not merely corroborated) for lifecycle-grade reliability", async () => {
  const corroborated = outcome.resolveIndependentOutcomeEvidenceEventIds(first.outcomes, projectRoot, {
    abrainHome,
    targetSlug: "joined-memory",
    requireReliableAttribution: true,
  });
  assert(corroborated.length === 0, `corroborated must not satisfy requireReliableAttribution: ${JSON.stringify(corroborated)}`);

  const fixture = await outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome,
    projectRoot,
    targetSlug: "joined-memory",
    producerNonce: "resolver-attributed-1",
  });
  assert(fixture.ok && fixture.eventId, JSON.stringify(fixture));
  const attributed = outcome.resolveIndependentOutcomeEvidenceEventIds([fixture.eventId], projectRoot, {
    abrainHome,
    targetSlug: "joined-memory",
    requireReliableAttribution: true,
  });
  assert(attributed.length === 1 && attributed[0] === fixture.eventId, JSON.stringify(attributed));
  assert(outcome.resolveIndependentOutcomeEvidenceEventIds([fixture.eventId], projectRoot, { abrainHome, targetSlug: "other", requireReliableAttribution: true }).length === 0, "foreign slug joined");
  assert(outcome.resolveIndependentOutcomeEvidenceEventIds(first.rejudges, projectRoot, { abrainHome }).length === 0, "LLM rejudge gained independent authority");
});

await check("resolver targetProposalId binds prompt-revision unlocks to exact proposal_id via real L1/index", async () => {
  const proposalId = "prp-smoke-prompt-revision-bind";
  const wrongProposalId = "prp-smoke-wrong-bind";

  // Ordinary attributed independent fixture has no proposal_id → cannot unlock a proposal join.
  const unbound = await outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome,
    projectRoot,
    targetSlug: "prompt-revision-memory",
    producerNonce: "resolver-proposal-unbound",
  });
  assert(unbound.ok && unbound.eventId, JSON.stringify(unbound));
  const unboundRow = outcome.readOutcomeEvidenceIndex(abrainHome).find((row) => row.event_id === unbound.eventId);
  assert(unboundRow?.attribution_status === "attributed" && unboundRow.evidence_independence === "independent_execution", JSON.stringify(unboundRow));
  assert(!unboundRow.proposal_id, `ordinary fixture must omit proposal_id: ${JSON.stringify(unboundRow)}`);
  assert(
    outcome.resolveIndependentOutcomeEvidenceEventIds([unbound.eventId], projectRoot, {
      abrainHome,
      requireReliableAttribution: true,
      targetProposalId: proposalId,
    }).length === 0,
    "unbound attributed independent event unlocked targetProposalId",
  );

  // Correct proposal_id bind unlocks only that target.
  const bound = await outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome,
    projectRoot,
    targetSlug: "prompt-revision-memory",
    proposalId,
    producerNonce: "resolver-proposal-bound",
  });
  assert(bound.ok && bound.eventId, JSON.stringify(bound));
  const boundRow = outcome.readOutcomeEvidenceIndex(abrainHome).find((row) => row.event_id === bound.eventId);
  assert(boundRow?.proposal_id === proposalId, `index must carry proposal_id: ${JSON.stringify(boundRow)}`);
  const matched = outcome.resolveIndependentOutcomeEvidenceEventIds([bound.eventId], projectRoot, {
    abrainHome,
    requireReliableAttribution: true,
    targetProposalId: proposalId,
  });
  assert(matched.length === 1 && matched[0] === bound.eventId, JSON.stringify(matched));

  // Wrong proposal_id must not unlock.
  assert(
    outcome.resolveIndependentOutcomeEvidenceEventIds([bound.eventId], projectRoot, {
      abrainHome,
      requireReliableAttribution: true,
      targetProposalId: wrongProposalId,
    }).length === 0,
    "wrong proposal_id joined",
  );

  // Wrong-bound fixture cannot unlock the target proposal.
  const wrongBound = await outcome.appendAttributedIndependentOutcomeFixture({
    abrainHome,
    projectRoot,
    targetSlug: "prompt-revision-memory",
    proposalId: wrongProposalId,
    producerNonce: "resolver-proposal-wrong-bound",
  });
  assert(wrongBound.ok && wrongBound.eventId, JSON.stringify(wrongBound));
  assert(
    outcome.resolveIndependentOutcomeEvidenceEventIds([wrongBound.eventId], projectRoot, {
      abrainHome,
      requireReliableAttribution: true,
      targetProposalId: proposalId,
    }).length === 0,
    "foreign proposal_id joined",
  );
});

console.log(`\nTotal: ${passed + failures.length}  Passed: ${passed}  Failed: ${failures.length}`);
if (failures.length) process.exit(1);
