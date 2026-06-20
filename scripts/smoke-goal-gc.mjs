#!/usr/bin/env node
/**
 * Smoke: goal v2 gc-archive — evidence scoped to active goal_id (no leak from
 * a previous/abandoned goal) + gcEvidence compaction + staleByTime hint.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const E = await jiti.import(`${repoRoot}/extensions/goal/evidence.ts`);

console.log("goal v2 — gc / archive + goal_id scoping");

function ev(rec) { return { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: rec }; }
function mk(goalId, id, status, over = {}) {
  return E.makeEvidenceRecord({
    goalId, sessionId: "s", criterionId: id, criterionText: `${id} text`,
    kind: "cmd", raw: "cmd:x", status, result: { exit: status === "verified" ? 0 : 1 }, ...over,
  });
}

await check("replay scoped to goal_id: a new goal does NOT inherit a prior goal's evidence", async () => {
  // same criterion id "c1" verified under the OLD goal, only failed under the NEW goal
  const branch = [
    ev(mk("g-old", "c1", "verified")),
    ev(mk("g-new", "c1", "failed")),
  ];
  const all = E.replayGoalEvidenceEvents(branch);
  assert(all.get("c1").length === 2, "unscoped folds both goals");
  const scopedNew = E.replayGoalEvidenceEvents(branch, { goalId: "g-new" });
  assert(scopedNew.get("c1").length === 1, "scoped to new goal -> 1 record");
  assert(E.latestVerified(scopedNew.get("c1")) === undefined, "new goal has NO verified for c1 (no leak from g-old)");
  const flatOld = E.replayGoalEvidenceFlat(branch, { goalId: "g-old" });
  assert(flatOld.length === 1 && flatOld[0].goal_id === "g-old", "flat scoped filter");
});

await check("gcEvidence keeps latest verified + last K failures per criterion", async () => {
  const recs = [mk("g", "c1", "verified"), mk("g", "c1", "failed"), mk("g", "c1", "failed"), mk("g", "c1", "failed"), mk("g", "c1", "verified")];
  const gc = E.gcEvidence(recs, { keepFailuresPerCriterion: 2 });
  assert(gc.kept.length === 3, `kept ${gc.kept.length} (expect latest verified + 2 failures)`);
  assert(gc.archived === 2, `archived ${gc.archived}`);
  assert(gc.kept.filter((r) => r.status === "verified").length === 1, "exactly one verified kept");
  assert(gc.kept.filter((r) => r.status === "failed").length === 2, "two failures kept");
});

await check("gcEvidence multi-criterion + keepFailures=0", async () => {
  const recs = [mk("g", "a", "verified"), mk("g", "a", "failed"), mk("g", "b", "failed"), mk("g", "b", "verified")];
  const gc = E.gcEvidence(recs, { keepFailuresPerCriterion: 0 });
  assert(gc.kept.length === 2, "one latest-verified per criterion, no failures");
  assert(gc.archived === 2, "two dropped");
});

await check("staleByTime flags goals with no recent check activity", async () => {
  const NOW = Date.parse("2026-06-20T12:00:00Z");
  const old = [mk("g", "c1", "verified", { now: new Date(NOW - 10 * 86400000) })];
  const st = E.staleByTime(old, 7, NOW);
  assert(st.stale === true && st.ageDays > 7, `old -> stale: ${JSON.stringify(st)}`);
  const fresh = [mk("g", "c1", "verified", { now: new Date(NOW - 1 * 86400000) })];
  assert(E.staleByTime(fresh, 7, NOW).stale === false, "fresh -> not stale");
  assert(E.staleByTime([], 7, NOW).stale === false, "empty -> not stale");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal gc).`
  : `FAIL — ${failures.length}/${total} checks failed (goal gc).`);
process.exit(failures.length === 0 ? 0 : 1);
