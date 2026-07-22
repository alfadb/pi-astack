#!/usr/bin/env node
// ADR 0031 Phase 3 mutation 基元 smoke: markProposalsExecuted(幂等 + status 穿读路径)+
// setEntryHysteresis(锁 + RMW + preserve + minimal 建行)。这些是 opus M4/M5 review
// P0-1/P0-2/P0-3 的修复基元 —— executor 真实路径将复用它们。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forgetting-prim-")); // sandbox: 不碰生产 ~/.abrain
process.env.ABRAIN_ROOT = tmp;
const jiti = createJiti(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS:", m); } else { fail++; console.error("FAIL:", m); } };

const pr = path.join(tmp, "proj");
fs.mkdirSync(pr, { recursive: true });

const elp = await jiti.import("../extensions/sediment/entry-lifecycle-proposals.ts");
const et = await jiti.import("../extensions/sediment/entry-telemetry.ts");
const oe = await jiti.import("../extensions/sediment/outcome-evidence.ts");

// ---- markProposalsExecuted: 幂等 + status 穿读路径(P0-1) ----
// Lifecycle archive proposals require independently verified attributed L1
// outcome evidence. Seed real resolver-valid fixtures (not synthetic hex only).
async function seedEvidence(slug) {
  const seeded = await oe.appendAttributedIndependentOutcomeFixture({ projectRoot: pr, targetSlug: slug, producerNonce: `mutation-prim:${slug}` });
  if (!seeded.ok || !seeded.eventId) throw new Error(`seed evidence failed for ${slug}: ${JSON.stringify(seeded)}`);
  return seeded.eventId;
}
const evidenceA = await seedEvidence("decay-target-a");
const evidenceB = await seedEvidence("decay-target-b");
const promoted = [
  { slug: "decay-target-a", kind: "decision", lifecycle_proposal: { op: "archive", reason: "affirm_superseded", independent_evidence: "entry X supersedes A", independent_evidence_event_ids: [evidenceA], falsifier: "if X is invalid" } },
  { slug: "decay-target-b", kind: "fact", lifecycle_proposal: { op: "archive", reason: "affirm_stale", independent_evidence: "B references removed API", independent_evidence_event_ids: [evidenceB], falsifier: "if API still exists" } },
];
const appended = elp.appendLifecycleProposals({ projectRoot: pr, promoted });
ok(appended.ok && appended.proposals_appended === 2, `append 2 pending archive proposals (got ${appended.proposals_appended})`);

// Negative: no evidence → autonomous defer (production gate stays fail-closed).
const deferred = elp.appendLifecycleProposals({
  projectRoot: pr,
  promoted: [{ slug: "no-evidence-target", kind: "fact", lifecycle_proposal: { op: "archive", reason: "affirm_superseded", independent_evidence: "claim only", independent_evidence_event_ids: [], falsifier: "if not" } }],
});
ok(deferred.ok && deferred.proposals_appended === 1, "no-evidence proposal appends as deferred");
ok(elp.readLifecycleProposals(pr).find((r) => r.slug === "no-evidence-target")?.status === "deferred_until_new_evidence", "no-evidence proposal is deferred_until_new_evidence");

let rows = elp.readLifecycleProposals(pr);
const pending = rows.filter((r) => r.status === "pending");
ok(pending.length === 2 && pending.every((r) => ["decay-target-a", "decay-target-b"].includes(r.slug)), "read back → 2 pending evidence-backed archives");

const marked = elp.markProposalsExecuted(pr, ["decay-target-a"]);
ok(marked.ok && marked.updated === 1, `markProposalsExecuted([a]) → updated 1 (got ${marked.updated})`);

rows = elp.readLifecycleProposals(pr);
const a = rows.find((r) => r.slug === "decay-target-a");
const b = rows.find((r) => r.slug === "decay-target-b");
ok(a && a.status === "executed", "P0-1: executed status SURVIVES read path (not forced back to pending)");
ok(b && b.status === "pending", "untouched proposal stays pending");

const markedAgain = elp.markProposalsExecuted(pr, ["decay-target-a"]);
ok(markedAgain.ok && markedAgain.updated === 0, `idempotent: 2nd markExecuted([a]) → updated 0 (got ${markedAgain.updated})`);

// ---- setEntryHysteresis: 锁 + preserve + minimal 建行(P0-2) ----
// setEntryHysteresis 复用 entryTelemetryGlobalLockPath() —— 与 mergeEntryTelemetry 同一把锁
// (结构上保证不 lost-update);这里测 RMW preserve + minimal 建行。
const cooldownIso = "2026-07-01 00:00:00 +0800";
const hys = et.setEntryHysteresis(pr, "decay-target-a", { proposal_cooldown_until: cooldownIso });
ok(hys.ok, "setEntryHysteresis ok (creates minimal row)");
let tel = et.getEntryTelemetry(pr, "decay-target-a");
ok(tel && tel.proposal_cooldown_until === cooldownIso && tel.total_retrievals === 0, "minimal row: cooldown set + derived zeroed");

// second call with a DIFFERENT field must PRESERVE the first (RMW, not clobber)
const holdoutIso = "2026-08-01 00:00:00 +0800";
const hys2 = et.setEntryHysteresis(pr, "decay-target-a", { holdout_until: holdoutIso });
ok(hys2.ok, "2nd setEntryHysteresis ok");
tel = et.getEntryTelemetry(pr, "decay-target-a");
ok(tel && tel.proposal_cooldown_until === cooldownIso, "P0-2: prior cooldown PRESERVED across 2nd write (RMW, no clobber)");
ok(tel && tel.holdout_until === holdoutIso, "P0-2: new holdout written alongside");

// minimal row when entry absent
const hys3 = et.setEntryHysteresis(pr, "never-seen-slug", { proposal_cooldown_until: cooldownIso });
ok(hys3.ok, "setEntryHysteresis on absent slug ok");
const tel2 = et.getEntryTelemetry(pr, "never-seen-slug");
ok(tel2 && tel2.proposal_cooldown_until === cooldownIso && tel2.total_retrievals === 0, "minimal row created with cooldown + zeroed derived");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — forgetting mutation primitives: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
