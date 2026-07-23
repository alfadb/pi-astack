#!/usr/bin/env node
/** Phase-2 event-first acceptance for every Knowledge mutation. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const childMode = process.argv.find((arg) => arg.startsWith("--child="))?.slice(8);

function assert(value, message) {
  if (!value) throw new Error(message);
}

if (childMode === "hold-ofd") {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const barrier = await jiti.import(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));
  const abrainHome = path.resolve(process.env.SMOKE_ABRAIN);
  const releaseFile = path.resolve(process.env.SMOKE_RELEASE_FILE);
  await barrier.withCanonicalMutationBarrier(abrainHome, async () => {
    process.stdout.write("OFD_HELD\n");
    while (!fs.existsSync(releaseFile)) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  process.stdout.write("OFD_RELEASED\n");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-knowledge-mutations-"));
const abrainHome = path.join(tmp, "abrain");
const projectRoot = path.join(tmp, "project");
const smokeHome = path.join(tmp, "home");
const settingsPath = path.join(tmp, "settings.json");
const projectId = "phase2-project";
for (const dir of [abrainHome, projectRoot, path.join(smokeHome, ".pi", "agent")]) fs.mkdirSync(dir, { recursive: true });

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initGit(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "phase2@example.test"]);
  git(cwd, ["config", "user.name", "phase2 smoke"]);
  fs.writeFileSync(path.join(cwd, ".seed"), "seed\n");
  git(cwd, ["add", ".seed"]);
  git(cwd, ["commit", "-q", "-m", "seed"]);
}
initGit(abrainHome);
initGit(projectRoot);

const settingsJson = `${JSON.stringify({
  canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
  sediment: {
    enabled: true,
    gitCommit: true,
    knowledgeEvidenceEventWriter: {
      enabled: true,
      mode: "event_first",
      legacyFallbackOnEventFailure: false,
      legacyMarkdownWriteOnSuccessfulEvent: false,
    },
    knowledgeProjector: {
      enabled: true,
      hotOverlayEnabled: false,
      projectOnWrite: true,
      maxReadBytes: 1000000,
      l2OutputRoot: "repo",
      projectionMode: "topo",
      canonicalReadMode: "projection_only",
      hotOverlay: { maxEntries: 500, maxTokens: 2000000, deadlineMs: 30000 },
    },
  },
}, null, 2)}\n`;
fs.writeFileSync(settingsPath, settingsJson);
fs.writeFileSync(path.join(smokeHome, ".pi", "agent", "pi-astack-settings.json"), settingsJson);
process.env.HOME = smokeHome;
process.env.ABRAIN_ROOT = abrainHome;
process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const writer = await jiti.import(path.join(root, "extensions/sediment/writer.ts"));
const settingsModule = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
const knowledge = await jiti.import(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
const outbox = await jiti.import(path.join(root, "extensions/sediment/publication-outbox.ts"));
const checkpoint = await jiti.import(path.join(root, "extensions/sediment/checkpoint.ts"));
const sediment = await jiti.import(path.join(root, "extensions/sediment/index.ts"));
const settings = settingsModule.resolveSedimentSettings();

function auditContext(sessionId, candidateId, sourceTimestampUtc, windowId) {
  return {
    lane: "phase2_smoke",
    sessionId,
    candidateId,
    sourceTimestampUtc,
    ...(windowId ? { windowId } : {}),
  };
}

function opts(sessionId, candidateId, sourceTimestampUtc) {
  return {
    projectRoot,
    abrainHome,
    projectId,
    settings,
    auditContext: auditContext(sessionId, candidateId, sourceTimestampUtc),
  };
}

function draft(slug, status = "active") {
  const title = slug.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  return {
    title,
    preferredSlug: slug,
    kind: "fact",
    status,
    provenance: "assistant-observed",
    confidence: 8,
    compiledTruth: `# ${title}\n\nStable seed content for ${slug}; this body is long enough for validation.`,
    sessionId: `seed-${slug}`,
    timelineNote: "phase2 stable seed",
  };
}

function eventIds(results) {
  return results.map((result) => result.knowledgeEvidenceEvent?.append?.eventId).filter(Boolean);
}

function assertAccepted(results, label) {
  assert(results.length > 0, `${label}: empty results`);
  assert(sediment._shouldAdvanceAfterResultsForTests(results), `${label}: checkpoint predicate held: ${JSON.stringify(results)}`);
  for (const result of results) {
    assert(result.status !== "rejected", `${label}: rejected: ${JSON.stringify(result)}`);
    assert(result.publication?.status === "durable_pending", `${label}: not durable_pending: ${JSON.stringify(result.publication)}`);
    assert(result.publication?.drainStatus === "publication_outbox_enqueued", `${label}: missing outbox receipt`);
    assert(result.knowledgeEvidenceEvent?.append?.ok === true, `${label}: L1 append missing`);
  }
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file));
    else if (entry.isFile()) out.push(file);
  }
  return out.sort();
}

function treeFingerprint(dir) {
  const hash = createHash("sha256");
  for (const file of walkFiles(dir)) {
    hash.update(path.relative(dir, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectProcess(proc) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    closed: new Promise((resolve) => proc.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))),
  };
}

async function waitForOutput(info, pattern, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(info.stdout())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${pattern}; stdout=${info.stdout()} stderr=${info.stderr()}`);
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

console.log("sediment phase-2 all-Knowledge mutation acceptance");
console.log(`  tmp=${tmp}`);

const seedSlugs = [
  "mut-update", "mut-delete", "mut-archive", "mut-supersede", "mut-reactivate",
  "merge-target", "merge-source-a", "merge-source-b", "race-slug", "crash-target", "crash-source",
  "hold-target", "hold-source", "hold-single",
];

await check("seed stable L1/L2 views in canonical-enabled temp Git", async () => {
  for (let i = 0; i < seedSlugs.length; i += 1) {
    const slug = seedSlugs[i];
    const status = slug === "mut-reactivate" ? "archived" : "active";
    const result = await writer.writeProjectEntry(
      draft(slug, status),
      opts(`seed-${slug}`, `seed:${slug}`, new Date(Date.UTC(2026, 6, 23, 1, 0, i)).toISOString()),
    );
    assertAccepted([result], `seed:${slug}`);
  }
  const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(drain.status === "completed" && drain.pending === 0, `seed publisher did not drain: ${JSON.stringify(drain)}`);
  for (const slug of seedSlugs) {
    const stablePath = path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects", projectId, `${slug}.md`);
    assert(fs.existsSync(stablePath), `stable view missing: ${slug}`);
  }
});

await check("busy publisher trigger returns immediately and leaves work pending", async () => {
  const item = outbox.buildPublicationOutboxItem({
    domain: "generic",
    sessionId: "publisher-busy-session",
    artifactPaths: [],
    candidateKey: "publisher-busy-candidate",
    operation: "busy-probe",
    projectKnowledge: false,
    publishGit: false,
  });
  await outbox.writePublicationOutboxItem(abrainHome, item);
  let release;
  let started;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const first = outbox.schedulePublicationOutboxDrain(abrainHome, async () => {
    started();
    await releasePromise;
    return "retry";
  });
  await startedPromise;
  const busyStarted = Date.now();
  const busy = await outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done");
  assert(busy.status === "busy" && Date.now() - busyStarted < 100, `busy trigger waited: ${JSON.stringify(busy)}`);
  release();
  await first;
  assert((await outbox.listPublicationOutboxPending(abrainHome)).some((row) => row.itemId === item.itemId), "busy/retry path deleted pending work");
  const cleanup = await outbox.schedulePublicationOutboxDrain(abrainHome, async () => "done");
  assert(cleanup.status === "completed" && cleanup.pending === 0, `busy fixture cleanup failed: ${JSON.stringify(cleanup)}`);

  const batchId = "b".repeat(64);
  const batchA = outbox.buildPublicationOutboxItem({
    domain: "generic", sessionId: "batch", artifactPaths: [], candidateKey: "batch-a", operation: "merge",
    projectKnowledge: false, publishGit: false, batchId, batchSize: 2,
  });
  await outbox.writePublicationOutboxItem(abrainHome, batchA);
  let handled = 0;
  const partial = await outbox.schedulePublicationOutboxDrain(abrainHome, async () => { handled += 1; return "done"; });
  assert(partial.processed === 0 && partial.pending === 1 && handled === 0, `partial publication batch escaped: ${JSON.stringify(partial)}`);
  const batchB = outbox.buildPublicationOutboxItem({
    domain: "generic", sessionId: "batch", artifactPaths: [], candidateKey: "batch-b", operation: "archive",
    projectKnowledge: false, publishGit: false, batchId, batchSize: 2,
  });
  await outbox.writePublicationOutboxItem(abrainHome, batchB);
  const complete = await outbox.schedulePublicationOutboxDrain(abrainHome, async () => { handled += 1; return "done"; });
  assert(complete.processed === 2 && complete.pending === 0 && handled === 2, `complete publication batch did not drain: ${JSON.stringify(complete)}`);
});

await check("terminal status reject advances without L1/outbox", async () => {
  const l1Count = (await knowledge.collectAllKnowledgeEventNodes(abrainHome)).length;
  const pendingCount = (await outbox.listPublicationOutboxPending(abrainHome)).length;
  const rejected = await writer.archiveProjectEntry("hold-single", {
    ...opts("session-single-hold", "candidate:single-hold", "2026-07-23T01:59:59.000Z"),
    reason: "single candidate hold fixture",
    sessionId: "session-single-hold",
    expected_status: "archived",
  });
  assert(rejected.status === "rejected" && rejected.reason === "status_precondition_failed", `terminal taxonomy was rewritten: ${JSON.stringify(rejected)}`);
  assert(sediment._shouldAdvanceAfterResultsForTests([rejected]), "deterministic status reject must advance checkpoint predicate");
  assert((await knowledge.collectAllKnowledgeEventNodes(abrainHome)).length === l1Count, "rejected event-first candidate appended L1");
  assert((await outbox.listPublicationOutboxPending(abrainHome)).length === pendingCount, "rejected event-first candidate enqueued outbox");
});

await check("event-first merge member failure holds checkpoint and partial batch", async () => {
  const patch = {
    compiledTruth: "# Hold Target\n\nA merge group is accepted only after every target/source event receipt is durable.",
    reason: "merge hold fixture",
    sessionId: "session-merge-hold",
  };
  const mergeOpts = {
    ...opts("session-merge-hold", "candidate:merge-hold", "2026-07-23T02:00:00.000Z"),
    sourceExpectedStatus: { "hold-source": "archived" },
  };
  const failed = await writer.mergeProjectEntries("hold-target", ["hold-source"], patch, mergeOpts);
  assert(failed.some((result) => result.status === "rejected" && result.reason?.startsWith("merge_group_incomplete:")), `merge member failure was not grouped: ${JSON.stringify(failed)}`);
  assert(!sediment._shouldAdvanceAfterResultsForTests(failed), "incomplete merge advanced checkpoint predicate");
  const partial = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(partial.processed === 0 && partial.pending === 1, `incomplete merge batch published: ${JSON.stringify(partial)}`);

  const replay = await writer.mergeProjectEntries("hold-target", ["hold-source"], patch, {
    ...mergeOpts,
    sourceExpectedStatus: { "hold-source": "active" },
  });
  assertAccepted(replay, "merge-hold-replay");
  assert(eventIds(failed)[0] === eventIds(replay)[0], "merge hold replay changed durable target event");
  const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(drain.status === "completed" && drain.pending === 0, `completed merge hold batch did not drain: ${JSON.stringify(drain)}`);
});

const l2Root = path.join(abrainHome, "l2", "views", "knowledge");
const headBefore = git(abrainHome, ["rev-parse", "HEAD"]).trim();
const l2Before = treeFingerprint(l2Root);
const l1BeforeCount = (await knowledge.collectAllKnowledgeEventNodes(abrainHome)).length;
const releaseFile = path.join(tmp, "release-ofd");
const holder = spawn(process.execPath, [scriptFile, "--child=hold-ofd"], {
  cwd: root,
  env: { ...process.env, SMOKE_ABRAIN: abrainHome, SMOKE_RELEASE_FILE: releaseFile },
  stdio: ["ignore", "pipe", "pipe"],
});
const holderInfo = collectProcess(holder);
await waitForOutput(holderInfo, /OFD_HELD/);

const acceptedGroups = [];
const acceptedIds = new Set();
let raceEventIds = [];

await check("update/delete/archive/supersede/reactivate accept while OFD is busy", async () => {
  const update = await writer.updateProjectEntry("mut-update", {
    compiledTruth: "# Mut Update\n\nUpdated Knowledge payload accepted independently from publication.",
    sessionId: "session-update",
    timelineNote: "stable update operation",
  }, opts("session-update", "candidate:update", "2026-07-23T02:00:01.000Z"));

  const deleted = await writer.deleteProjectEntry("mut-delete", {
    ...opts("session-delete", "candidate:delete", "2026-07-23T02:00:02.000Z"),
    mode: "hard",
    reason: "stable hard delete operation",
    sessionId: "session-delete",
    expected_status: "active",
  });
  const archived = await writer.archiveProjectEntry("mut-archive", {
    ...opts("session-archive", "candidate:archive", "2026-07-23T02:00:03.000Z"),
    reason: "stable archive operation",
    sessionId: "session-archive",
    expected_status: "active",
  });
  const superseded = await writer.supersedeProjectEntry("mut-supersede", {
    ...opts("session-supersede", "candidate:supersede", "2026-07-23T02:00:04.000Z"),
    reason: "stable supersede operation",
    newSlug: "replacement-entry",
    sessionId: "session-supersede",
  });
  const reactivated = await writer.updateProjectEntry("mut-reactivate", {
    status: "active",
    expected_status: "archived",
    sessionId: "session-reactivate",
    timelineAction: "reactivated",
    timelineNote: "stable reactivation authorization",
  }, {
    ...opts("session-reactivate", "candidate:reactivate", "2026-07-23T02:00:05.000Z"),
    auditOperation: "archive_reactivation_apply",
  });

  for (const [label, results] of [
    ["update", [update]], ["delete", [deleted]], ["archive", [archived]],
    ["supersede", [superseded]], ["reactivate", [reactivated]],
  ]) {
    assertAccepted(results, label);
    acceptedGroups.push([label, results]);
    for (const id of eventIds(results)) acceptedIds.add(id);
  }
  assert(update.knowledgeEvidenceEvent.body.created_at_utc === "2026-07-23T02:00:01.000Z", "update source timestamp drifted");
  assert(deleted.knowledgeEvidenceEvent.body.intent.operation_hint === "delete", "soft/hard delete event operation drifted");
  assert(reactivated.knowledgeEvidenceEvent.body.intent.operation_hint === "update", "reactivate invented an unsupported schema operation");
});

await check("merge accepts target and every source as one checkpoint unit", async () => {
  const results = await writer.mergeProjectEntries("merge-target", ["merge-source-a", "merge-source-b"], {
    compiledTruth: "# Merge Target\n\nMerged target carries the complete deterministic phase-two truth.",
    reason: "stable merge operation",
    timelineNote: "stable merge operation",
    sessionId: "session-merge",
  }, {
    ...opts("session-merge", "candidate:merge", "2026-07-23T02:00:06.000Z"),
    sourceExpectedStatus: { "merge-source-a": "active", "merge-source-b": "active" },
  });
  assert(results.length === 3, `merge did not return all events: ${JSON.stringify(results)}`);
  assertAccepted(results, "merge");
  acceptedGroups.push(["merge", results]);
  for (const id of eventIds(results)) acceptedIds.add(id);
  assert(results.every((result) => result.knowledgeEvidenceEvent.body.created_at_utc === "2026-07-23T02:00:06.000Z"), "merge event timestamps are not replay-stable");
});

await check("concurrent same-slug events both accept and replay identically", async () => {
  const run = () => Promise.all([
    writer.updateProjectEntry("race-slug", {
      compiledTruth: "# Race Slug\n\nConcurrent branch alpha is a complete valid Knowledge payload.",
      sessionId: "session-race",
      timelineNote: "race alpha",
    }, opts("session-race", "candidate:race-alpha", "2026-07-23T02:00:07.000Z")),
    writer.updateProjectEntry("race-slug", {
      compiledTruth: "# Race Slug\n\nConcurrent branch beta is a complete valid Knowledge payload.",
      sessionId: "session-race",
      timelineNote: "race beta",
    }, opts("session-race", "candidate:race-beta", "2026-07-23T02:00:07.000Z")),
  ]);
  const first = await run();
  assertAccepted(first, "same-slug race");
  const firstIds = eventIds(first).sort();
  raceEventIds = firstIds;
  assert(new Set(firstIds).size === 2, `race collapsed distinct events: ${JSON.stringify(firstIds)}`);
  const replay = await run();
  assertAccepted(replay, "same-slug replay");
  assert(JSON.stringify(eventIds(replay).sort()) === JSON.stringify(firstIds), "same-slug replay minted new event ids");
  acceptedGroups.push(["same-slug", first]);
  for (const id of firstIds) acceptedIds.add(id);
});

await check("merge partial-crash residue replays to the same target event", async () => {
  const crashAuditContext = auditContext("session-crash-merge", "candidate:crash-merge", "2026-07-23T02:00:08.000Z");
  const crashBatch = writer.knowledgeMergePublicationBatchContext({
    targetSlug: "crash-target",
    sourceSlugs: ["crash-source"],
    compiledTruth: "# Crash Target\n\nCrash-replay target truth is deterministic across partial acceptance.",
    sessionId: "session-crash-merge",
    auditContext: crashAuditContext,
  });
  const commonOpts = {
    projectRoot, abrainHome, projectId, settings,
    auditContext: { ...crashAuditContext, ...crashBatch },
    auditOperation: "merge",
    auditExtras: { sources: ["crash-source"], reason: "crash replay merge" },
  };
  const partial = await writer.updateProjectEntry("crash-target", {
    compiledTruth: "# Crash Target\n\nCrash-replay target truth is deterministic across partial acceptance.",
    sessionId: "session-crash-merge",
    timelineAction: "merged",
    timelineNote: "crash replay merge",
    frontmatterPatch: { derives_from: ["crash-source"] },
  }, commonOpts);
  assertAccepted([partial], "partial merge target");
  const replay = await writer.mergeProjectEntries("crash-target", ["crash-source"], {
    compiledTruth: "# Crash Target\n\nCrash-replay target truth is deterministic across partial acceptance.",
    reason: "crash replay merge",
    timelineNote: "crash replay merge",
    sessionId: "session-crash-merge",
  }, {
    ...opts("session-crash-merge", "candidate:crash-merge", "2026-07-23T02:00:08.000Z"),
    sourceExpectedStatus: { "crash-source": "active" },
  });
  assertAccepted(replay, "merge crash replay");
  assert(partial.knowledgeEvidenceEvent.append.eventId === replay[0].knowledgeEvidenceEvent.append.eventId, "partial merge target replay minted a new event");
  const replayItems = (await outbox.listPublicationOutboxPending(abrainHome)).filter((row) => eventIds(replay).includes(row.item.eventId));
  assert(replayItems.length === 2 && replayItems.every((row) => row.item.batchId === crashBatch.publicationBatchId && row.item.batchSize === 2), "merge replay did not complete one stable publication batch");
  acceptedGroups.push(["merge-crash-replay", replay]);
  for (const id of eventIds(replay)) acceptedIds.add(id);
});

await check("all accepted operations advance independent checkpoint slots", async () => {
  let index = 0;
  for (const [label, results] of acceptedGroups) {
    assert(sediment._shouldAdvanceAfterResultsForTests(results), `${label}: result group must advance`);
    const sessionId = `checkpoint-${label}`;
    const entryId = `entry-${String(index++).padStart(2, "0")}`;
    await checkpoint.saveSessionCheckpoint(projectRoot, sessionId, { lastProcessedEntryId: entryId });
    const saved = await checkpoint.loadSessionCheckpoint(projectRoot, sessionId);
    assert(saved.lastProcessedEntryId === entryId, `${label}: checkpoint not durable`);
  }
});

await check("OFD busy freezes mutable L2 and Git while L1/outbox grow", async () => {
  const nodes = await knowledge.collectAllKnowledgeEventNodes(abrainHome);
  assert(nodes.length === l1BeforeCount + acceptedIds.size, `unexpected L1 cardinality: before=${l1BeforeCount} accepted=${acceptedIds.size} now=${nodes.length}`);
  const pending = await outbox.listPublicationOutboxPending(abrainHome);
  assert(pending.length === acceptedIds.size, `one outbox item per event violated: ${pending.length} vs ${acceptedIds.size}`);
  for (const row of pending) {
    assert(acceptedIds.has(row.item.eventId), `outbox references unknown event: ${row.item.eventId}`);
    assert(Array.isArray(row.item.artifactPaths) && row.item.artifactPaths.length === 0, "knowledge outbox copied artifact/payload material");
  }
  assert(treeFingerprint(l2Root) === l2Before, "L2 changed while canonical OFD was busy");
  assert(git(abrainHome, ["rev-parse", "HEAD"]).trim() === headBefore, "HEAD advanced while canonical OFD was busy");
});

fs.writeFileSync(releaseFile, "release\n");
const holderResult = await holderInfo.closed;
assert(holderResult.code === 0, `OFD holder failed: ${holderResult.stderr}`);

await check("one-shot publisher converges deterministic topo fold after release", async () => {
  const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(drain.status === "completed" && drain.pending === 0, `publisher did not drain: ${JSON.stringify(drain)}`);
  assert((await outbox.listPublicationOutboxPending(abrainHome)).length === 0, "pending publication work remains");
  assert(treeFingerprint(l2Root) !== l2Before, "L2 did not converge");
  assert(git(abrainHome, ["rev-parse", "HEAD"]).trim() !== headBefore, "HEAD did not converge");

  const raceNodes = (await knowledge.collectKnowledgeEventSet(abrainHome, `project:${projectId}:race-slug`));
  const expected = knowledge.renderKnowledgeProjectionFromSet(raceNodes);
  const racePath = path.join(l2Root, "latest", "projects", projectId, "race-slug.md");
  assert(expected.kind === "entry" && fs.readFileSync(racePath, "utf8") === expected.markdown, "same-slug L2 is not the deterministic topo fold");
  const deletePath = path.join(l2Root, "latest", "projects", projectId, "mut-delete.md");
  assert(!fs.existsSync(deletePath), "delete tombstone did not remove L2 entry");

  const l1CountBeforeReplay = (await knowledge.collectAllKnowledgeEventNodes(abrainHome)).length;
  const postPublicationReplay = await Promise.all([
    writer.updateProjectEntry("race-slug", {
      compiledTruth: "# Race Slug\n\nConcurrent branch alpha is a complete valid Knowledge payload.",
      sessionId: "session-race", timelineNote: "race alpha",
    }, opts("session-race", "candidate:race-alpha", "2026-07-23T02:00:07.000Z")),
    writer.updateProjectEntry("race-slug", {
      compiledTruth: "# Race Slug\n\nConcurrent branch beta is a complete valid Knowledge payload.",
      sessionId: "session-race", timelineNote: "race beta",
    }, opts("session-race", "candidate:race-beta", "2026-07-23T02:00:07.000Z")),
  ]);
  assert(JSON.stringify(eventIds(postPublicationReplay).sort()) === JSON.stringify(raceEventIds), "post-publication replay changed event identity with a new stable parent");
  assert((await knowledge.collectAllKnowledgeEventNodes(abrainHome)).length === l1CountBeforeReplay, "post-publication replay appended new L1 events");
  assert((await outbox.listPublicationOutboxPending(abrainHome)).length === 0, "done outbox receipts were re-enqueued on replay");
});

await check("detached HEAD leaves knowledge publication pending (not failed)", async () => {
  const update = await writer.updateProjectEntry("mut-update", {
    compiledTruth: "# Mut Update\n\nDetached-head retry must keep the accepted receipt pending.",
    sessionId: "session-detached-retry",
    timelineNote: "detached retry fixture",
  }, opts("session-detached-retry", "candidate:detached-retry", "2026-07-23T03:00:00.000Z"));
  assertAccepted([update], "detached-retry-accept");
  const eventId = update.knowledgeEvidenceEvent.append.eventId;
  const pendingBefore = await outbox.listPublicationOutboxPending(abrainHome);
  const row = pendingBefore.find((item) => item.item.eventId === eventId);
  assert(row, "detached fixture missing pending receipt");
  const branch = git(abrainHome, ["branch", "--show-current"]).trim() || "main";
  git(abrainHome, ["checkout", "--detach", "HEAD"]);
  try {
    const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
    assert(/publication_ref_unavailable|detached|unsafe HEAD ref/i.test(drain.lastError || ""), `detached drain missing ref lastError: ${JSON.stringify(drain)}`);
    assert((await outbox.listPublicationOutboxPending(abrainHome)).some((item) => item.item.eventId === eventId), "detached HEAD drained accepted knowledge receipt");
    assert(!fs.existsSync(path.join(outbox.publicationOutboxFailedDir(abrainHome), `${row.itemId}.json`)), "detached HEAD terminal-failed knowledge receipt");
  } finally {
    git(abrainHome, ["checkout", "-q", branch]);
  }
  const recover = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(recover.status === "completed", `reattached drain failed: ${JSON.stringify(recover)}`);
  assert(!(await outbox.listPublicationOutboxPending(abrainHome)).some((item) => item.item.eventId === eventId), "reattached publisher did not drain knowledge receipt");
});

await check("windowId is stamped on every knowledge outbox item; exact window holds only itself", async () => {
  const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));
  const windowA = "1".repeat(64);
  const sessionId = "session-window-stamp";
  const created = await writer.writeProjectEntry(
    draft("window-stamp", "active"),
    {
      ...opts(sessionId, "candidate:window-stamp", "2026-07-23T03:01:00.000Z"),
      auditContext: auditContext(sessionId, "candidate:window-stamp", "2026-07-23T03:01:00.000Z", windowA),
    },
  );
  // draft helper uses writeProjectEntry opts differently; use update on existing stable seed if create path already seeded.
  let eventId = created?.knowledgeEvidenceEvent?.append?.eventId;
  let itemRow;
  if (created.status === "rejected") {
    const updated = await writer.updateProjectEntry("mut-update", {
      compiledTruth: "# Mut Update\n\nWindow stamp proof payload for exact readiness.",
      sessionId,
      timelineNote: "window stamp",
    }, {
      ...opts(sessionId, "candidate:window-stamp", "2026-07-23T03:01:00.000Z"),
      auditContext: auditContext(sessionId, "candidate:window-stamp", "2026-07-23T03:01:00.000Z", windowA),
    });
    assertAccepted([updated], "window-stamp-update");
    eventId = updated.knowledgeEvidenceEvent.append.eventId;
  } else {
    assertAccepted([created], "window-stamp-create");
  }
  itemRow = (await outbox.listPublicationOutboxPending(abrainHome)).find((row) => row.item.eventId === eventId);
  assert(itemRow?.item.windowId === windowA, `knowledge outbox missing windowId: ${JSON.stringify(itemRow?.item)}`);

  const sessionFileB = path.join(projectRoot, "window-b-session.jsonl");
  fs.writeFileSync(sessionFileB, "");
  const pendingB = intake.buildSedimentIntakeRecord({
    sessionId,
    sessionFile: sessionFileB,
    cwd: projectRoot,
    branchTip: { id: "tip-b", parentId: null, type: "message", timestampUtc: "2026-07-23T03:01:00.000Z" },
    captureBoundary: { kind: "agent_end", boundaryUntrusted: false, terminalAssistantStopReason: "stop" },
  });
  // Use the real content-addressed windowB path while stamping receipts with synthetic windowA.
  assert(pendingB.windowId !== windowA, "fixture windows collided");
  await intake.writeSedimentIntakeRecord(abrainHome, pendingB);
  // Same-session different window pending must not hold windowA receipt.
  const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(drain.status === "completed", `window readiness drain failed: ${JSON.stringify(drain)}`);
  assert(!(await outbox.listPublicationOutboxPending(abrainHome)).some((row) => row.item.eventId === eventId), "exact-window ready knowledge receipt stayed pending behind foreign window");
  await intake.ackSedimentIntake(abrainHome, pendingB.windowId);

  // Holding exact window keeps receipt pending.
  const held = await writer.updateProjectEntry("mut-update", {
    compiledTruth: "# Mut Update\n\nExact window hold proof payload remains pending until its intake acks.",
    sessionId,
    timelineNote: "exact window hold",
  }, {
    ...opts(sessionId, "candidate:window-hold", "2026-07-23T03:02:00.000Z"),
    auditContext: auditContext(sessionId, "candidate:window-hold", "2026-07-23T03:02:00.000Z", windowA),
  });
  assertAccepted([held], "window-hold-accept");
  const heldEventId = held.knowledgeEvidenceEvent.append.eventId;
  // Synthetic pending path for the stamped windowA — readiness keys on path presence.
  fs.mkdirSync(intake.sedimentIntakePendingDir(abrainHome), { recursive: true });
  fs.writeFileSync(intake.sedimentIntakePendingPath(abrainHome, windowA), `${JSON.stringify({ schema: intake.SEDIMENT_INTAKE_SCHEMA, windowId: windowA })}\n`);
  const heldDrain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert((await outbox.listPublicationOutboxPending(abrainHome)).some((row) => row.item.eventId === heldEventId), `exact pending window was published: ${JSON.stringify(heldDrain)}`);
  fs.rmSync(intake.sedimentIntakePendingPath(abrainHome, windowA), { force: true });
  const releaseDrain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(releaseDrain.status === "completed" && !(await outbox.listPublicationOutboxPending(abrainHome)).some((row) => row.item.eventId === heldEventId), `released exact window did not drain: ${JSON.stringify(releaseDrain)}`);
});

await check("merge members share one windowId and one publication batch", async () => {
  const windowId = "5".repeat(64);
  const sessionId = "session-merge-window";
  // Seed two active entries for merge members.
  for (const [i, slug] of ["mw-target", "mw-source"].entries()) {
    const seed = await writer.writeProjectEntry(
      draft(slug, "active"),
      {
        ...opts(`seed-${slug}`, `seed:${slug}`, new Date(Date.UTC(2026, 6, 23, 3, 10, i)).toISOString()),
        auditContext: auditContext(`seed-${slug}`, `seed:${slug}`, new Date(Date.UTC(2026, 6, 23, 3, 10, i)).toISOString(), windowId),
      },
    );
    if (seed.status !== "rejected") assertAccepted([seed], `seed-${slug}`);
  }
  await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  const results = await writer.mergeProjectEntries("mw-target", ["mw-source"], {
    compiledTruth: "# Mw Target\n\nMerge members must carry the same durable intake window.",
    reason: "window-shared merge",
    timelineNote: "window-shared merge",
    sessionId,
  }, {
    ...opts(sessionId, "candidate:merge-window", "2026-07-23T03:11:00.000Z"),
    auditContext: auditContext(sessionId, "candidate:merge-window", "2026-07-23T03:11:00.000Z", windowId),
    sourceExpectedStatus: { "mw-source": "active" },
  });
  assertAccepted(results, "merge-window");
  assert(results.length === 2, `merge window member count: ${results.length}`);
  const pending = (await outbox.listPublicationOutboxPending(abrainHome))
    .filter((row) => eventIds(results).includes(row.item.eventId));
  assert(pending.length === 2, `merge window outbox count: ${pending.length}`);
  assert(pending.every((row) => row.item.windowId === windowId), `merge members missing shared windowId: ${JSON.stringify(pending.map((row) => row.item.windowId))}`);
  const batchIds = new Set(pending.map((row) => row.item.batchId));
  assert(batchIds.size === 1 && pending.every((row) => row.item.batchSize === 2), `merge members lost atomic batch identity: ${JSON.stringify(pending)}`);
  const drain = await writer.scheduleKnowledgePublicationOutboxDrain(abrainHome, settings);
  assert(drain.status === "completed" && drain.pending === 0, `merge window drain failed: ${JSON.stringify(drain)}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`PASS - ${passed} all-Knowledge mutation checks passed.`);
