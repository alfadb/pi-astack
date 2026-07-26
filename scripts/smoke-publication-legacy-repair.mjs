#!/usr/bin/env node
/** Explicit single-item repair for the legacy world publication project stamp. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const outbox = await jiti.import(path.join(root, "extensions/sediment/publication-outbox.ts"));
const knowledge = await jiti.import(path.join(root, "extensions/sediment/knowledge-evidence.ts"));
const writer = await jiti.import(path.join(root, "extensions/sediment/writer.ts"));
const worker = await jiti.import(path.join(root, "extensions/sediment/worker-rpc.ts"));
const settingsModule = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
const barrier = await jiti.import(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));

function assert(value, message) {
  if (!value) throw new Error(message);
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-publication-repair-"));
const copyStore = path.join(tmp, "copy-store");
const ownerRoot = path.join(tmp, "owner");
fs.mkdirSync(copyStore, { recursive: true });
fs.mkdirSync(ownerRoot, { recursive: true });
process.env.PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT = copyStore;
process.env.PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS = JSON.stringify([fs.realpathSync.native(ownerRoot)]);

const baseSettings = settingsModule.resolveSedimentSettings();
function eventSettings(overrides = {}) {
  return {
    ...baseSettings,
    gitCommit: true,
    knowledgeEvidenceEventWriter: {
      ...baseSettings.knowledgeEvidenceEventWriter,
      enabled: true,
      mode: "event_first",
      legacyFallbackOnEventFailure: false,
      legacyMarkdownWriteOnSuccessfulEvent: false,
    },
    knowledgeProjector: {
      ...baseSettings.knowledgeProjector,
      enabled: true,
      projectOnWrite: true,
      l2OutputRoot: "repo",
      projectionMode: "topo",
    },
    ...overrides,
  };
}

function freshHome(label) {
  const home = path.join(tmp, label);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

async function appendWorldL1(abrainHome, slug, suffix = "") {
  const sessionId = `repair-session-${slug}${suffix}`;
  const candidateKey = `repair-candidate-${slug}${suffix}`;
  const sourceTimestampUtc = `2026-07-2${suffix ? "6" : "5"}T01:02:03.000Z`;
  const result = await knowledge.appendKnowledgeEvidenceForWrite({
    abrainHome,
    projectId: "pi-global",
    scope: "world",
    draft: {
      title: `Repair ${slug}`,
      preferredSlug: slug,
      kind: "pattern",
      status: "active",
      provenance: "assistant-observed",
      confidence: 8,
      compiledTruth: `# Repair ${slug}\n\nStable production-shaped Knowledge body for ${slug}.`,
      sessionId,
      timelineNote: "legacy repair smoke",
    },
    result: { slug, path: "", status: "created" },
    settings: eventSettings(),
    auditContext: {
      lane: "auto_write",
      sessionId,
      candidateId: candidateKey,
      sourceTimestampUtc,
    },
    sessionId,
    operation: "create",
    createdAtUtc: sourceTimestampUtc,
    deferPublication: true,
    legacyParallelWrite: {
      attempted: false,
      status: "created",
      reason: "legacy_markdown_write_disabled",
    },
  });
  assert(result.append.ok && result.append.eventId && result.body, `L1 append failed for ${slug}: ${JSON.stringify(result.append)}`);
  assert(result.body.scope.kind === "world" && !("project_id" in result.body.scope), "world L1 unexpectedly has project_id");
  return {
    eventId: result.append.eventId,
    l1FilePath: result.append.filePath,
    body: result.body,
    sessionId,
    candidateKey,
    sourceTimestampUtc,
  };
}

function legacyItemFor(event, overrides = {}) {
  const identity = {
    domain: "knowledge",
    sessionId: event.sessionId,
    eventId: event.eventId,
    artifactPaths: [],
    candidateKey: event.candidateKey,
    operation: "create",
    slug: event.body.payload.slug,
    projectId: "pi-global",
    scope: "world",
    projectKnowledge: true,
    publishGit: true,
    sourceTimestampUtc: event.sourceTimestampUtc,
    ...overrides,
  };
  const itemId = outbox.computePublicationOutboxItemId(identity);
  return {
    schema: outbox.SEDIMENT_PUBLICATION_OUTBOX_SCHEMA,
    itemId,
    ...identity,
    note: "accepted_pending_publication",
  };
}

function terminalReceipt(item) {
  return {
    status: "failed",
    reason: "knowledge_publication_validation_failed",
    failedAtUtc: "2026-07-25T01:03:00.000Z",
    item,
  };
}

function seedFailed(abrainHome, item) {
  const dir = outbox.publicationOutboxFailedDir(abrainHome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${item.itemId}.json`), `${JSON.stringify(terminalReceipt(item))}\n`, { mode: 0o600 });
}

function seedResolved(abrainHome, item) {
  const dir = outbox.publicationOutboxResolvedDir(abrainHome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${item.itemId}.json`), `${JSON.stringify(terminalReceipt(item))}\n`, { mode: 0o600 });
}

function normalizedLegacyItem(item) {
  const normalized = { ...item };
  delete normalized.projectId;
  normalized.itemId = outbox.computePublicationOutboxItemId(normalized);
  return normalized;
}

function stateFingerprint(abrainHome) {
  const rootDir = outbox.publicationOutboxRoot(abrainHome);
  const rows = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push([`${path.relative(rootDir, file)}/`, null]);
        walk(file);
      } else rows.push([path.relative(rootDir, file), fs.readFileSync(file, "base64")]);
    }
  }
  walk(rootDir);
  return JSON.stringify(rows);
}

function maintenanceRequest(overrides = {}) {
  return {
    schema: worker.SEDIMENT_WORKER_MAINTENANCE_SCHEMA,
    request_id: hex64(`repair-maintenance-${Math.random()}`),
    budget_ms: 60_000,
    kind: "publication_outbox",
    ...overrides,
  };
}

function maintenanceDeps(abrainHome, drain) {
  return {
    resolveAbrainHome: () => abrainHome,
    resolveEffectiveExecutionOwner: () => "daemon",
    drainKnowledgePublicationOutbox: drain,
    countPublicationOutboxPending: () => outbox.countPublicationOutboxPending(abrainHome),
    countPublicationOutboxFailed: () => outbox.countPublicationOutboxFailed(abrainHome),
    env: process.env,
  };
}

function readAuditRows(abrainHome) {
  const file = path.join(abrainHome, ".state", "sediment", "audit.jsonl");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readRepairAudits(abrainHome) {
  return readAuditRows(abrainHome).filter((row) => row.operation === "publication_outbox_legacy_repair");
}

function seedRepairAudit(abrainHome, item) {
  const normalized = normalizedLegacyItem(item);
  const file = path.join(abrainHome, ".state", "sediment", "audit.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    timestamp: "2026-07-25T09:04:00+08:00",
    audit_version: 2,
    pid: process.pid,
    lane: "publication",
    operation: "publication_outbox_legacy_repair",
    reason: "legacy_world_project_stamp_repaired",
    old_internal_id: item.itemId,
    new_internal_id: normalized.itemId,
    repaired_at_utc: "2026-07-25T01:04:00.000Z",
  })}\n`, "utf8");
}

console.log("publication legacy world project-stamp repair");
console.log(`  tmp=${tmp}`);

await check("new world enqueue omits projectId; project enqueue preserves exact projectId", async () => {
  const worldHome = freshHome("new-world");
  const projectRoot = path.join(tmp, "writer-project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const settings = eventSettings({ gitCommit: false });
  const draft = (slug) => ({
    title: `New ${slug}`,
    preferredSlug: slug,
    kind: "fact",
    status: "active",
    provenance: "assistant-observed",
    confidence: 8,
    compiledTruth: `# New ${slug}\n\nScope-aware enqueue contract fixture for ${slug}.`,
    sessionId: `new-${slug}`,
  });
  const baseOptions = (abrainHome, candidateId, sourceTimestampUtc) => ({
    projectRoot,
    abrainHome,
    projectId: "exact-project",
    settings,
    auditContext: { lane: "auto_write", sessionId: candidateId, candidateId, sourceTimestampUtc },
  });
  const world = await writer.writeProjectEntry(
    draft("world-item"),
    { ...baseOptions(worldHome, "new-world-candidate", "2026-07-26T02:00:00.000Z"), scope: "world" },
  );
  assert(world.status === "created", `world enqueue rejected: ${JSON.stringify(world)}`);
  const worldRows = await outbox.listPublicationOutboxPending(worldHome);
  assert(worldRows.length === 1 && worldRows[0].item.scope === "world", "world pending item missing");
  assert(!("projectId" in worldRows[0].item), "world pending item retained projectId");

  const projectHome = freshHome("new-project");
  const project = await writer.writeProjectEntry(
    draft("project-item"),
    { ...baseOptions(projectHome, "new-project-candidate", "2026-07-26T02:00:01.000Z"), scope: "project" },
  );
  assert(project.status === "created", `project enqueue rejected: ${JSON.stringify(project)}`);
  const projectRows = await outbox.listPublicationOutboxPending(projectHome);
  assert(projectRows.length === 1 && projectRows[0].item.projectId === "exact-project", "projectId was not preserved exactly");
  let rejectedWorldStamp = false;
  try {
    outbox.buildPublicationOutboxItem({
      domain: "knowledge", sessionId: "x", eventId: "a".repeat(64), artifactPaths: [],
      candidateKey: "x", operation: "create", slug: "x", scope: "world", projectId: "pi-global",
    });
  } catch {
    rejectedWorldStamp = true;
  }
  assert(rejectedWorldStamp, "new builder accepted legacy world project stamp");
});

await check("explicit maintenance repairs one eligible item, drains to done, and appends one durable audit", async () => {
  const home = freshHome("eligible");
  const event = await appendWorldL1(home, "eligible-world");
  const legacy = legacyItemFor(event);
  seedFailed(home, legacy);
  const failedPath = path.join(outbox.publicationOutboxFailedDir(home), `${legacy.itemId}.json`);
  const oldFailedBytes = fs.readFileSync(failedPath);
  const result = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), maintenanceDeps(home, () => outbox.schedulePublicationOutboxDrain(home, async (item) => {
    assert(item.scope === "world" && !("projectId" in item), "drain saw non-normalized repaired item");
    return "done";
  })));
  assert(result.status === "drained", `repair maintenance did not drain: ${JSON.stringify(result)}`);
  assert(result.repair_status === "repaired" && result.repaired_bucket === "1", `repair result closure: ${JSON.stringify(result)}`);
  assert(result.failed_bucket === "0", "final failed bucket is not real zero");
  assert(await outbox.countPublicationOutboxFailed(home) === 0, "failed count did not decrease");
  assert(await outbox.countPublicationOutboxResolved(home) === 1, "resolved count did not increase");
  assert(await outbox.countPublicationOutboxPending(home) === 0, "repaired item remained pending after drain");
  const resolvedBytes = fs.readFileSync(path.join(outbox.publicationOutboxResolvedDir(home), `${legacy.itemId}.json`));
  assert(resolvedBytes.equals(oldFailedBytes), "resolved history did not retain exact old failed bytes");
  const normalized = normalizedLegacyItem(legacy);
  assert(fs.existsSync(path.join(outbox.publicationOutboxDoneDir(home), `${normalized.itemId}.json`)), "normalized item did not reach done");
  const audits = readRepairAudits(home);
  assert(audits.length === 1, `expected one repair audit, got ${audits.length}`);
  assert(audits[0].reason === "legacy_world_project_stamp_repaired", "repair audit reason drifted");
  assert(audits[0].old_internal_id === legacy.itemId && audits[0].new_internal_id === normalized.itemId, "repair audit internal ids missing");
  assert(typeof audits[0].repaired_at_utc === "string", "repair audit time missing");

  const again = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), maintenanceDeps(home, async () => { throw new Error("already repaired done item must not drain"); }));
  assert(again.status === "idle" && again.repair_status === "already_repaired", `already repaired result: ${JSON.stringify(again)}`);
  assert(again.repaired_bucket === "0" && readRepairAudits(home).length === 1, "already repair duplicated mutation/audit");
  assert(worker.maintenanceResultNotifyHasSensitiveContent(worker.formatWorkerMaintenanceResultNotify(again)) === false, "repair result notify leaked identity");
  assert(worker.sanitizeWorkerMaintenanceResult({ ...again, repaired_bucket: "2" }) === null, "non-closed repaired bucket accepted");
  assert(worker.sanitizeWorkerMaintenanceResult({ ...again, repair_status: "bulk" }) === null, "non-closed repair status accepted");
});

await check("extra identity mismatch is not eligible and normal policy none is zero-mutation", async () => {
  const mismatchHome = freshHome("mismatch");
  const mismatchEvent = await appendWorldL1(mismatchHome, "mismatch-world");
  seedFailed(mismatchHome, legacyItemFor(mismatchEvent, { operation: "update" }));
  const mismatch = await outbox.repairLegacyWorldProjectStampFailures(mismatchHome, 1);
  assert(mismatch.status === "not_eligible" && mismatch.repaired === 0, "operation mismatch was repaired");
  assert(await outbox.countPublicationOutboxFailed(mismatchHome) === 1, "mismatch failed item moved");
  assert(await outbox.countPublicationOutboxResolved(mismatchHome) === 0, "mismatch created resolved history");
  assert(await outbox.countPublicationOutboxPending(mismatchHome) === 0, "mismatch created pending item");
  const mismatchMaintenance = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), maintenanceDeps(mismatchHome, async () => { throw new Error("ineligible failed item must not drain"); }));
  assert(mismatchMaintenance.status === "failed" && mismatchMaintenance.error_code === "publication_terminal_failed_present", `ineligible maintenance status: ${JSON.stringify(mismatchMaintenance)}`);
  assert(mismatchMaintenance.repair_status === "not_eligible" && mismatchMaintenance.repaired_bucket === "0", "not-eligible result closure drifted");
  assert(mismatchMaintenance.failed_bucket === "1", "not-eligible result lost real failed count");

  const noneHome = freshHome("policy-none");
  const noneEvent = await appendWorldL1(noneHome, "none-world");
  seedFailed(noneHome, legacyItemFor(noneEvent));
  const before = stateFingerprint(noneHome);
  let drainCalls = 0;
  const none = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest()), maintenanceDeps(noneHome, async () => {
    drainCalls += 1;
    return { status: "completed", processed: 0, drained: 0, terminalFailed: 0, pending: 0 };
  }));
  assert(none.status === "failed" && none.error_code === "publication_terminal_failed_present", `normal none status: ${JSON.stringify(none)}`);
  assert(!("repair_status" in none) && !("repaired_bucket" in none), "policy none changed legacy maintenance result keys");
  assert(worker.sanitizeWorkerMaintenanceResult({ ...none, repair_status: "none", repaired_bucket: "0" }) === null,
    "wire sanitizer accepted repair fields for the none outcome");
  assert(drainCalls === 0 && stateFingerprint(noneHome) === before, "normal policy none mutated publication state");
});

await check("limit is closed to 0|1 and one invocation repairs at most one failed item", async () => {
  const home = freshHome("limit");
  for (const [slug, suffix] of [["limit-a", "a"], ["limit-b", "b"]]) {
    const event = await appendWorldL1(home, slug, suffix);
    seedFailed(home, legacyItemFor(event));
  }
  const zeroBefore = stateFingerprint(home);
  const zero = await outbox.repairLegacyWorldProjectStampFailures(home, 0);
  assert(zero.status === "not_eligible" && stateFingerprint(home) === zeroBefore, "limit=0 mutated state");
  const one = await outbox.repairLegacyWorldProjectStampFailures(home, 1);
  assert(one.status === "repaired" && one.repaired === 1, "limit=1 did not repair one");
  assert(await outbox.countPublicationOutboxFailed(home) === 1, "limit=1 repaired more than one failed item");
  assert(await outbox.countPublicationOutboxResolved(home) === 1, "limit=1 resolved count mismatch");
  assert(await outbox.countPublicationOutboxPending(home) === 1, "limit=1 pending count mismatch");
  let limitRejected = false;
  try { await outbox.repairLegacyWorldProjectStampFailures(home, 2); } catch { limitRejected = true; }
  assert(limitRejected, "repair primitive accepted limit=2");
  for (const bad of [
    { repair_policy: "legacy_world_project_stamp" },
    { repair_policy: "legacy_world_project_stamp", repair_limit: 0 },
    { repair_policy: "legacy_world_project_stamp", repair_limit: 2 },
    { repair_policy: "none", repair_limit: 1 },
    { repair_limit: 1 },
    { repair_policy: "bulk", repair_limit: 1 },
  ]) {
    let rejected = false;
    try { worker.validateSedimentWorkerMaintenanceRequest(maintenanceRequest(bad)); } catch { rejected = true; }
    assert(rejected, `maintenance accepted invalid repair contract ${JSON.stringify(bad)}`);
  }
});

await check("crash after pending enqueue resumes identically and resolves failed without delete", async () => {
  const home = freshHome("crash-pending");
  const event = await appendWorldL1(home, "crash-pending-world");
  seedFailed(home, legacyItemFor(event));
  let crashed = false;
  try {
    await outbox.repairLegacyWorldProjectStampFailures(home, 1, {
      crashHook: (point) => {
        assert(barrier.canonicalMutationBarrierHeld(home), "repair crash hook ran outside canonical barrier");
        if (point === "after_pending_enqueue") throw new Error("cut after pending");
      },
    });
  } catch { crashed = true; }
  assert(crashed, "pending cutpoint did not fire");
  assert(await outbox.countPublicationOutboxPending(home) === 1, "pending was not durable before cut");
  assert(await outbox.countPublicationOutboxFailed(home) === 1, "failed moved before pending cut");
  assert(await outbox.countPublicationOutboxResolved(home) === 0, "resolved appeared before rename");
  const resumed = await outbox.repairLegacyWorldProjectStampFailures(home, 1);
  assert(resumed.status === "repaired", `pending crash did not resume: ${JSON.stringify(resumed)}`);
  assert(await outbox.countPublicationOutboxPending(home) === 1, "resume duplicated/lost pending");
  assert(await outbox.countPublicationOutboxFailed(home) === 0 && await outbox.countPublicationOutboxResolved(home) === 1, "resume did not finish atomic resolve");
});

await check("resolved audit recovery visits all rows and fills a missing second audit without L1 or destinations", async () => {
  const home = freshHome("resolved-audit-scan");
  const firstEvent = await appendWorldL1(home, "resolved-audit-first", "1");
  const secondEvent = await appendWorldL1(home, "resolved-audit-second", "2");
  const first = legacyItemFor(firstEvent);
  const second = legacyItemFor(secondEvent);
  seedResolved(home, first);
  seedResolved(home, second);
  seedRepairAudit(home, first);
  fs.rmSync(firstEvent.l1FilePath);
  fs.rmSync(secondEvent.l1FilePath);

  const recovered = await outbox.repairLegacyWorldProjectStampFailures(home, 1);
  assert(recovered.status === "already_repaired" && recovered.repaired === 0, `resolved recovery status: ${JSON.stringify(recovered)}`);
  const audits = readRepairAudits(home);
  assert(audits.length === 2, `resolved recovery did not fill exactly the second audit: ${audits.length}`);
  for (const item of [first, second]) {
    const normalized = normalizedLegacyItem(item);
    assert(audits.filter((row) => row.old_internal_id === item.itemId && row.new_internal_id === normalized.itemId).length === 1,
      `resolved audit pair was not deduplicated for ${item.itemId}`);
    assert(!fs.existsSync(path.join(outbox.publicationOutboxPendingDir(home), `${normalized.itemId}.json`)), "audit recovery recreated pending state");
    assert(!fs.existsSync(path.join(outbox.publicationOutboxDoneDir(home), `${normalized.itemId}.json`)), "audit recovery required done state");
  }
});

await check("repair busy and budget are retryable pending; closed failure writes durable audit", async () => {
  const busyHome = freshHome("repair-busy");
  const busy = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), {
    ...maintenanceDeps(busyHome, async () => { throw new Error("busy repair must not drain"); }),
    repairLegacyWorldProjectStampFailures: async () => {
      throw new barrier.CanonicalMutationBarrierError("CANONICAL_MUTATION_BUSY", "test detail must stay private");
    },
  });
  assert(busy.status === "pending" && busy.retryable === true && busy.error_code === "publication_repair_busy", `repair busy closure: ${JSON.stringify(busy)}`);
  assert(busy.repair_status === "busy" && busy.repaired_bucket === "unknown", "repair busy aggregate fields drifted");

  const budgetHome = freshHome("repair-budget");
  const budget = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), {
    ...maintenanceDeps(budgetHome, async () => { throw new Error("budget repair must not drain"); }),
    repairLegacyWorldProjectStampFailures: async () => {
      throw new worker.WorkerDeadlineError("worker_budget_exhausted", "test detail must stay private");
    },
  });
  assert(budget.status === "pending" && budget.retryable === true && budget.error_code === "publication_repair_budget", `repair budget closure: ${JSON.stringify(budget)}`);
  assert(budget.repair_status === "budget" && budget.repaired_bucket === "unknown", "repair budget aggregate fields drifted");

  const failedHome = freshHome("repair-failed-audit");
  const failed = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), {
    ...maintenanceDeps(failedHome, async () => { throw new Error("failed repair must not drain"); }),
    repairLegacyWorldProjectStampFailures: async () => {
      throw new outbox.LegacyWorldProjectStampRepairError("conflict");
    },
  });
  assert(failed.status === "failed" && failed.retryable === false && failed.error_code === "publication_repair_failed", `repair failure closure: ${JSON.stringify(failed)}`);
  const failureAudits = readAuditRows(failedHome).filter((row) => row.operation === "repair_failed");
  assert(failureAudits.length === 1 && failureAudits[0].reason === "conflict", "repair failure audit missing or not closed");
  assert(!("content" in failureAudits[0]) && !("path" in failureAudits[0]), "repair failure audit contains content/path");

  const auditFailureHome = freshHome("repair-audit-failure");
  fs.mkdirSync(path.join(auditFailureHome, ".state", "sediment", "audit.jsonl"), { recursive: true });
  const stderr = [];
  const originalConsoleError = console.error;
  console.error = (...args) => stderr.push(args.join(" "));
  try {
    await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
      repair_policy: "legacy_world_project_stamp",
      repair_limit: 1,
    })), {
      ...maintenanceDeps(auditFailureHome, async () => { throw new Error("failed repair must not drain"); }),
      repairLegacyWorldProjectStampFailures: async () => { throw new outbox.LegacyWorldProjectStampRepairError("io"); },
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert(stderr.length === 1 && stderr[0] === "[sediment-writer] publication_repair_audit_failed operation=repair_failed reason=audit_append_failed",
    `repair audit stderr was not closed: ${JSON.stringify(stderr)}`);
});

await check("crash after failed-to-resolved rename returns already_repaired and restores audit once", async () => {
  const home = freshHome("crash-resolved");
  const event = await appendWorldL1(home, "crash-resolved-world");
  seedFailed(home, legacyItemFor(event));
  const cutResult = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest({
    repair_policy: "legacy_world_project_stamp",
    repair_limit: 1,
  })), {
    ...maintenanceDeps(home, async () => { throw new Error("repair failure must not continue drain"); }),
    repairLegacyWorldProjectStampFailures: (abrainHome, limit) =>
      outbox.repairLegacyWorldProjectStampFailures(abrainHome, limit, {
        crashHook: (point) => { if (point === "after_failed_resolve") throw new Error("cut after resolve"); },
      }),
  });
  assert(cutResult.status === "failed" && cutResult.error_code === "publication_repair_failed", `resolved cutpoint result: ${JSON.stringify(cutResult)}`);
  assert(cutResult.repair_status === "failed" && cutResult.repaired_bucket === "unknown", "resolved cutpoint repair closure drifted");
  assert(cutResult.failed_bucket === "0" && cutResult.pending_after_bucket === "1", "repair failure buckets are not durable post-cut state");
  assert(await outbox.countPublicationOutboxFailed(home) === 0, "failed remained after atomic rename");
  assert(await outbox.countPublicationOutboxResolved(home) === 1, "resolved missing after atomic rename");
  assert(await outbox.countPublicationOutboxPending(home) === 1, "normalized pending missing after resolve cut");
  assert(readRepairAudits(home).length === 0, "audit appeared before cutpoint");
  const resumed = await outbox.repairLegacyWorldProjectStampFailures(home, 1);
  assert(resumed.status === "already_repaired" && resumed.repaired === 0, `resolved crash did not classify already: ${JSON.stringify(resumed)}`);
  assert(readRepairAudits(home).length === 1, "resolved crash did not restore exactly one durable audit");
  await outbox.repairLegacyWorldProjectStampFailures(home, 1);
  assert(readRepairAudits(home).length === 1, "idempotent rerun duplicated repair audit");
});

await check("symlink state conflict fails closed with original failed bytes untouched", async () => {
  const home = freshHome("symlink");
  const event = await appendWorldL1(home, "symlink-world");
  const legacy = legacyItemFor(event);
  seedFailed(home, legacy);
  const pendingDir = outbox.publicationOutboxPendingDir(home);
  const target = path.join(tmp, "symlink-target");
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, pendingDir);
  let rejected = false;
  try { await outbox.repairLegacyWorldProjectStampFailures(home, 1); } catch { rejected = true; }
  assert(rejected, "symlink pending directory was accepted");
  assert(await outbox.countPublicationOutboxFailed(home) === 1, "symlink conflict moved failed item");
  assert(await outbox.countPublicationOutboxResolved(home) === 0, "symlink conflict created resolved item");
  assert(fs.existsSync(path.join(outbox.publicationOutboxFailedDir(home), `${legacy.itemId}.json`)), "symlink conflict removed old failed bytes");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
