#!/usr/bin/env node
// ADR 0031 Phase 3 — END-TO-END real demote smoke.
//
// Why this exists: smoke-forgetting-executor-real exercises the executor
// orchestration with a MOCK archiveEntry, and smoke-cas-guard exercises the
// real updateProjectEntry archive+CAS DIRECTLY. Neither runs the production
// COMPOSITION: runForgettingExecutor → real archiveEntry closure → real
// updateProjectEntry → an actual entry .md flips active→archived on disk.
// In production that closure (extensions/sediment/index.ts agent_end wiring,
// ~L2072) has never fired because the aggregator has produced zero pending
// `op=archive` proposals — so "armed but never exercised". This smoke proves
// the full real path works: real entry → real proposal → real executor →
// real file mutation, body retained (resurrection-reachable), idempotent,
// CAS-safe. Sandbox abrain (ABRAIN_ROOT=tmp); gitCommit disabled.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0, fail = 0;
const check = (name, ok, why = "") => {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${why ? `  \u2190 ${why}` : ""}`); }
};
const readJsonl = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];

const writer = jiti(path.join(repoRoot, "extensions/sediment/writer.ts"));
const sedSettings = jiti(path.join(repoRoot, "extensions/sediment/settings.ts"));
const fx = jiti(path.join(repoRoot, "extensions/sediment/forgetting-executor.ts"));
const elp = jiti(path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts"));
const ar = jiti(path.join(repoRoot, "extensions/sediment/archive-reactivation.ts"));

const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-demote-e2e-abrain-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-demote-e2e-proj-"));
const projectId = "demote-e2e-fixture";
fs.mkdirSync(path.join(abrainHome, "projects", projectId), { recursive: true });
const prevRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = abrainHome; // sandbox device-id + ledger paths

const sediment = { ...sedSettings.DEFAULT_SEDIMENT_SETTINGS, gitCommit: false, lockTimeoutMs: 5000 };
const writeOpts = { projectRoot, abrainHome, projectId, settings: sediment, scope: "project" };

// Mirror the production agent_end archiveEntry closure: real updateProjectEntry
// with status=archived + proposal-pinned expected_status CAS.
const archiveEntry = async (target) => {
  try {
    const expectedStatus = target.expected_status ?? "active";
    const res = await writer.updateProjectEntry(
      target.slug,
      {
        status: "archived",
        expected_status: expectedStatus,
        timelineAction: "archived",
        timelineNote: `forgetting-executor v1(${target.reason}; expected_status=${expectedStatus})`,
        sessionId: "demote-e2e",
      },
      { ...writeOpts, dryRun: false, auditOperation: "forgetting_demote_apply" },
    );
    const okk = res.status !== "rejected";
    return { ok: okk, status: okk ? "archived" : "active", error: res.reason, rejected: !okk };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const NOW = Date.now(), DAY = 86_400_000;
// Warm the resurrection ledger to a stable sub-backoff rate (0.25 < 0.5) so the
// executor does not fail-safe into backoff for lack of data (mirror real smoke).
const reactLedger = ar.archiveReactivationLedgerPath();
fs.mkdirSync(path.dirname(reactLedger), { recursive: true });
const rrow = (decision, daysAgo, seq) => JSON.stringify({
  operation: "archive_reactivation_decision",
  project_root: path.resolve(projectRoot),
  slug: `r${seq}`, decision, ts: new Date(NOW - daysAgo * DAY).toISOString(),
});
fs.writeFileSync(reactLedger, [
  rrow("keep_archived", 2, 1), rrow("keep_archived", 4, 2), rrow("keep_archived", 6, 3), rrow("reactivate", 8, 4),
  rrow("keep_archived", 35, 5), rrow("keep_archived", 37, 6), rrow("keep_archived", 39, 7), rrow("reactivate", 41, 8),
].join("\n") + "\n", "utf-8");

const forgettingSettings = {
  forgetting: { enabled: true, executorRealApplyEnabled: true, instrumentation: false },
};

const BODY = [
  "This entry was created to exercise the real autonomous demote path end to end.",
  "It carries enough prose to pass markdown lint and to verify the body survives",
  "archival so the archived entry stays resurrection-reachable.",
].join(" ");

try {
  // 1) Create a REAL active entry on disk.
  const created = await writer.writeProjectEntry(
    { title: "Demote e2e fixture entry", kind: "fact", status: "active", confidence: 5, compiledTruth: BODY },
    writeOpts,
  );
  check("create real active entry", created.status === "created", JSON.stringify(created));
  const slug = created.slug;
  const file = created.path;
  check("entry file exists on disk", typeof file === "string" && fs.existsSync(file), String(file));
  check("entry file is active", fs.readFileSync(file, "utf-8").includes("status: active"));

  // 2) Queue a real pending archive proposal (truth-change driven, op=archive)
  // with independently verified attributed L1 outcome evidence.
  const oe = jiti(path.join(repoRoot, "extensions/sediment/outcome-evidence.ts"));
  const seeded = await oe.appendAttributedIndependentOutcomeFixture({
    projectRoot,
    targetSlug: slug,
    producerNonce: `demote-e2e:${slug}`,
  });
  check("seeded attributed independent outcome evidence", seeded.ok && !!seeded.eventId, JSON.stringify(seeded));
  elp.appendLifecycleProposals({
    projectRoot,
    promoted: [{
      slug,
      kind: "fact",
      lifecycle_proposal: {
        op: "archive",
        reason: "affirm_superseded",
        independent_evidence: `${slug} superseded by a newer fact`,
        independent_evidence_event_ids: [seeded.eventId],
        falsifier: "if still cited",
      },
    }],
  });
  const queued = elp.readLifecycleProposals(projectRoot).find((p) => p.slug === slug);
  check("proposal is pending", queued?.status === "pending", JSON.stringify(queued));
  check("proposal carries join fields", !!queued?.proposal_id && queued.evidence_source === "aggregator_promoted_advisory" && queued.evidence_type === "superseded_by", JSON.stringify(queued));

  // 3) Run the REAL executor with the REAL archiveEntry closure.
  const r = await fx.runForgettingExecutor(projectRoot, forgettingSettings, { globalWriteAuthority: true, archiveEntry, activeCorpusSize: 1000 }, new Date(NOW));
  check("executor ran in REAL mode (dry_run=false)", r.dry_run === false, JSON.stringify({ dry_run: r.dry_run, cb: r.circuit_breaker }));
  check("executor reports the entry demoted", (r.demoted || []).includes(slug), JSON.stringify(r.demoted));
  const ledgerRow = readJsonl(fx.forgettingDemoteLedgerPath()).find((row) => row.slug === slug);
  check("demote ledger carries proposal/evidence join fields", ledgerRow?.proposal_id === queued?.proposal_id && ledgerRow.evidence_source === "aggregator_promoted_advisory" && ledgerRow.evidence_type === "superseded_by" && ledgerRow.idempotency_key, JSON.stringify(ledgerRow));
  const auditRow = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  check("real audit carries planned/demoted proposal ids", auditRow?.schema_version === 1 && auditRow.row_kind === "real_apply" && auditRow.idempotency_key && auditRow.planned_proposal_ids?.includes(queued?.proposal_id) && auditRow.demoted_proposal_ids?.includes(queued?.proposal_id), JSON.stringify(auditRow));

  // 4) The REAL entry .md flipped active→archived, full body retained.
  const after = fs.readFileSync(file, "utf-8");
  check("entry .md flipped to archived on disk", /^status: archived$/m.test(after), after.slice(0, 160));
  check("archived entry retains full body (resurrection-reachable)", after.includes("exercise the real autonomous demote path end to end"));
  check("proposal marked executed", elp.readLifecycleProposals(projectRoot).find((p) => p.slug === slug)?.status === "executed");

  // 5) Idempotent: re-run demotes nothing (proposal executed + hysteresis).
  const r2 = await fx.runForgettingExecutor(projectRoot, forgettingSettings, { globalWriteAuthority: true, archiveEntry, activeCorpusSize: 1000 }, new Date(NOW));
  check("re-run is a no-op (idempotent)", (r2.demoted || []).length === 0, JSON.stringify(r2.demoted));

  // 6) CAS proof on the real closure: archiving an already-archived entry is
  //    rejected (expected_status:"active" fails), so a stale demote can never
  //    clobber an entry the user/brain has since reactivated.
  const direct = await archiveEntry({ slug, kind: "decision", reason: "stale-retry" });
  check("real archiveEntry CAS-rejects an already-archived entry", direct.rejected === true && direct.ok === false, JSON.stringify(direct));

  // 7) D* Phase 1 E1 path: a real superseded entry with a non-self successor
  //    gets a deterministic execution_ready proposal and archives under
  //    expected_status:"superseded" CAS.
  const createdSup = await writer.writeProjectEntry(
    { title: "Demote e2e superseded fixture entry", kind: "decision", status: "active", confidence: 5, compiledTruth: `${BODY} Superseded fixture variant.` },
    writeOpts,
  );
  check("create second active entry", createdSup.status === "created", JSON.stringify(createdSup));
  const supSlug = createdSup.slug;
  const supFile = createdSup.path;
  const superseded = await writer.supersedeProjectEntry(supSlug, { ...writeOpts, dryRun: false, reason: "fixture successor", newSlug: "demote-e2e-successor", sessionId: "demote-e2e" });
  check("fixture entry flipped to superseded", superseded.status === "superseded" && /^status: superseded$/m.test(fs.readFileSync(supFile, "utf-8")), JSON.stringify(superseded));
  const bridge = elp.appendSupersededFrontmatterProposals({
    projectRoot,
    entries: [{ slug: supSlug, kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["demote-e2e-successor"] }, relations: [{ type: "superseded_by", to: "demote-e2e-successor" }] }],
  });
  check("frontmatter bridge queued one E1", bridge.proposals_appended === 1 && bridge.e1_count === 1, JSON.stringify(bridge));
  const e1 = elp.readLifecycleProposals(projectRoot).find((p) => p.slug === supSlug);
  check("E1 proposal is execution_ready with expected_status=superseded", e1?.disposition === "execution_ready" && e1?.expected_status === "superseded", JSON.stringify(e1));
  check("E1 proposal carries frontmatter join fields", !!e1?.proposal_id && e1.evidence_source === "frontmatter_superseded" && e1.evidence_type === "superseded_by", JSON.stringify(e1));
  const r3 = await fx.runForgettingExecutor(projectRoot, forgettingSettings, { globalWriteAuthority: true, archiveEntry, activeCorpusSize: 1000 }, new Date(NOW));
  check("executor demoted the superseded E1 entry", (r3.demoted || []).includes(supSlug), JSON.stringify(r3.demoted));
  const supAfter = fs.readFileSync(supFile, "utf-8");
  check("superseded E1 entry .md flipped to archived", /^status: archived$/m.test(supAfter), supAfter.slice(0, 160));
} finally {
  if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevRoot;
  try { fs.rmSync(abrainHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
}

console.log("\n\u2500\u2500\u2500\u2500");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES \u2014 investigate before commit"); process.exit(1); }
process.exit(0);
