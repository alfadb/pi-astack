#!/usr/bin/env node
/**
 * Smoke: decay-shadow would_demote=true -> entry lifecycle proposal bridge.
 *
 * Uses a temporary ABRAIN_ROOT so the proposal sidecar stays sandboxed. Locks:
 *   - only truth-change-backed would_demote=true assessments become archive proposals
 *   - source/evidence fields carry decay audit context
 *   - slug de-duplication suppresses pending and executed archive proposals
 *   - per-run cap is bounded at 3
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-decay-proposal-bridge-"));
const prevRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = tmp;

const jiti = createJiti(import.meta.url);
const {
  appendDecayDemoteProposals,
  entryLifecycleProposalsPath,
  markProposalsExecuted,
  readLifecycleProposals,
} = await jiti.import(path.join(repoRoot, "extensions/sediment/entry-lifecycle-proposals.ts"));

let fails = 0;
const ok = (cond, msg, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}${cond || !detail ? "" : `\n  ${detail}`}`);
  if (!cond) fails++;
};

const projectA = path.join(tmp, "project-a");
const projectB = path.join(tmp, "project-b");
const projectC = path.join(tmp, "project-c");
const now = new Date("2026-07-08T00:00:00Z");
const assess = (slug, demote_evidence_type = "superseded_by", extra = {}) => ({
  slug,
  decay_score: 0.82,
  would_demote: true,
  demote_evidence_type,
  primary_driver: demote_evidence_type === "superseded_by" ? "supersede" : "staleness",
  decay_inputs: { window_retrieved_unused: 4, decisive_streak: 0, last_cited_at: "2026-05-01T00:00:00Z" },
  falsifier: `future evidence keeps ${slug} current`,
  ...extra,
});

try {
  ok(entryLifecycleProposalsPath().startsWith(tmp), "sandbox sidecar path is under temporary ABRAIN_ROOT");

  const aggregatorSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/aggregator.ts"), "utf-8");
  ok(
    /decay_proposals\?: \{[\s\S]*?ok: boolean;[\s\S]*?error\?: string;[\s\S]*?\};/.test(aggregatorSrc)
      && /enrichedSummary\.decay_proposals = \{[\s\S]*?ok: decayProposalResult\.ok,[\s\S]*?error: decayProposalResult\.error/.test(aggregatorSrc),
    "aggregator decay_proposals summary exposes append ok/error",
  );

  const first = appendDecayDemoteProposals({
    projectRoot: projectA,
    now,
    assessments: [
      assess("old-superseded", "superseded_by"),
      assess("stale-version", "version_stale", { decay_score: 0.74 }),
      assess("usage-only", null, { primary_driver: "disuse" }),
      { slug: "false-positive", decay_score: 0.9, would_demote: false, demote_evidence_type: "contradicted", primary_driver: "contradiction" },
      { slug: "", decay_score: 0.9, would_demote: true, demote_evidence_type: "superseded_by" },
    ],
  });
  ok(first.ok && first.proposals_appended === 2, "truth-change-backed decay assessments append two proposals", JSON.stringify(first));
  ok(first.source === "decay" && first.eligible === 2 && first.limited === 0, "result carries decay audit counts", JSON.stringify(first));

  const rows = readLifecycleProposals(projectA);
  const sup = rows.find((r) => r.slug === "old-superseded");
  const stale = rows.find((r) => r.slug === "stale-version");
  ok(rows.length === 2, "usage-only, false, and invalid-slug assessments are not proposed", JSON.stringify(rows));
  ok(sup?.op === "archive" && sup.reason === "affirm_superseded" && sup.status === "pending", "superseded_by maps to pending archive/affirm_superseded", JSON.stringify(sup));
  ok(stale?.reason === "affirm_stale" && stale.evidence_type === "version_stale", "version_stale maps to affirm_stale with evidence_type", JSON.stringify(stale));
  ok(sup?.evidence_source === "decay" && sup.evidence_key === "decay:old-superseded:superseded_by:supersede", "proposal carries source=decay and stable evidence_key", JSON.stringify(sup));
  ok(sup?.expected_status === "active" && sup.disposition === "execution_ready", "executor gates remain active CAS + execution_ready", JSON.stringify(sup));
  ok(typeof sup?.independent_evidence === "string" && sup.independent_evidence.includes("decay_score=0.820") && sup.independent_evidence.includes("primary_driver=supersede"), "decay audit evidence is carried in independent_evidence", JSON.stringify(sup));

  const replay = appendDecayDemoteProposals({ projectRoot: projectA, now, assessments: [assess("old-superseded"), assess("stale-version", "version_stale")] });
  ok(replay.proposals_appended === 0 && replay.skipped_duplicate_slug === 2, "pending archive proposal slugs are not proposed again", JSON.stringify(replay));

  const changedEvidenceReplay = appendDecayDemoteProposals({ projectRoot: projectA, now, assessments: [assess("old-superseded", "version_stale")] });
  const oldSupersededRows = readLifecycleProposals(projectA).filter((r) => r.slug === "old-superseded" && r.op === "archive");
  ok(
    changedEvidenceReplay.proposals_appended === 0 && changedEvidenceReplay.skipped_duplicate_slug === 1 && oldSupersededRows.length === 1,
    "same slug with different decay evidence_type/evidence_key is not proposed again",
    JSON.stringify({ changedEvidenceReplay, oldSupersededRows }),
  );

  const capped = appendDecayDemoteProposals({
    projectRoot: projectB,
    now,
    maxPerRun: 99,
    assessments: ["a", "b", "c", "d", "e"].map((slug) => assess(`cap-${slug}`, "contradicted", { primary_driver: "contradiction" })),
  });
  const cappedRows = readLifecycleProposals(projectB);
  ok(capped.proposals_appended === 3 && capped.limited === 2 && capped.max_per_run === 3, "per-run cap clamps to three proposals", JSON.stringify(capped));
  ok(cappedRows.length === 3 && cappedRows.every((r) => r.evidence_source === "decay"), "only capped rows land for the project", JSON.stringify(cappedRows));

  const once = appendDecayDemoteProposals({ projectRoot: projectC, now, assessments: [assess("processed-once")] });
  ok(once.proposals_appended === 1, "setup executed-proposal duplicate test", JSON.stringify(once));
  const marked = markProposalsExecuted(projectC, ["processed-once"]);
  ok(marked.ok && marked.updated === 1, "setup proposal marked executed", JSON.stringify(marked));
  const afterExecuted = appendDecayDemoteProposals({ projectRoot: projectC, now, assessments: [assess("processed-once")] });
  ok(afterExecuted.proposals_appended === 0 && afterExecuted.skipped_duplicate_slug === 1, "executed archive proposal slug is not proposed again", JSON.stringify(afterExecuted));
} finally {
  if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevRoot;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(fails === 0
  ? "\n✅ ALL PASS — decay proposal bridge: source/evidence, dedupe, cap"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
