#!/usr/bin/env node
/**
 * Smoke: goal v2 status-viz — goal_status evidence account: renderEvidenceLog
 * (recent N checks) over the GC'd kept set. Pure logic via jiti.
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

console.log("goal v2 — goal_status evidence visualization");

const NOW = Date.parse("2026-06-20T12:00:00Z");
function mk(id, status, kind, agoMin, over = {}) {
  return E.makeEvidenceRecord({
    goalId: "g-1", sessionId: "s", criterionId: id, criterionText: `${id} text`,
    kind, raw: `${kind}:x`, status,
    result: kind === "cmd" ? { exit: status === "verified" ? 0 : 1 } : { size: 10 },
    now: new Date(NOW - agoMin * 60000), ...over,
  });
}

await check("renderEvidenceLog shows recent N checks newest-last with marks + age", async () => {
  const recs = [mk("a", "failed", "cmd", 30), mk("a", "verified", "cmd", 10), mk("b", "verified", "file", 5)];
  const log = E.renderEvidenceLog(recs, 8, NOW);
  assert(/最近 3\/3 条 check/.test(log), `header: ${log.split("\n")[0]}`);
  assert(/✓ \(a\) cmd:exit 0 · 10m ago/.test(log), "verified a line with age");
  assert(/✗ \(a\) cmd:exit 1 · 30m ago/.test(log), "failed a line");
  assert(/✓ \(b\) file:10B · 5m ago/.test(log), "file b line");
});

await check("renderEvidenceLog caps to last N", async () => {
  const recs = Array.from({ length: 12 }, (_, i) => mk("c", i % 2 ? "verified" : "failed", "cmd", 12 - i));
  const log = E.renderEvidenceLog(recs, 5, NOW);
  assert(/最近 5\/12 条 check/.test(log), `cap header: ${log.split("\n")[0]}`);
  assert(log.split("\n").length === 6, "1 header + 5 lines");
});

await check("renderEvidenceLog empty -> explicit empty message", async () => {
  assert(/空/.test(E.renderEvidenceLog([], 8, NOW)), "empty marker");
});

await check("status block uses GC'd kept set (latest verified + recent failures)", async () => {
  // simulate buildStatusEvidenceBlock's gc step
  const recs = [mk("a", "verified", "cmd", 50), mk("a", "failed", "cmd", 40), mk("a", "failed", "cmd", 30), mk("a", "failed", "cmd", 20), mk("a", "verified", "cmd", 10)];
  const gc = E.gcEvidence(recs);
  // keep latest verified (10m) + last 2 failures (20m,30m); drop oldest verified (50m) + oldest failure (40m)
  assert(gc.kept.length === 3 && gc.archived === 2, `gc: kept ${gc.kept.length} archived ${gc.archived}`);
  const log = E.renderEvidenceLog(gc.kept, 8, NOW);
  assert(!/50m ago/.test(log) && !/40m ago/.test(log), "redundant records archived out of the log");
  assert(/✓ \(a\) cmd:exit 0 · 10m ago/.test(log), "current verified still shown");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal status-viz).`
  : `FAIL — ${failures.length}/${total} checks failed (goal status-viz).`);
process.exit(failures.length === 0 ? 0 : 1);
