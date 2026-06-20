#!/usr/bin/env node
/**
 * Smoke: goal v2 dedup-cache — findCachedVerified returns a prior verified
 * record only when the input fingerprint EXACTLY matches (criterion text +
 * evidence expr + declared input file shas); any drift -> miss (re-run).
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

console.log("goal v2 — goal_check dedup cache");

const ev = "cmd:npm test";
function fp(over = {}) {
  return {
    criterion_text_sha: E.criterionTextSha("run the suite"),
    evidence_sha: E.sha256short(ev),
    file_shas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
    ...over,
  };
}
const verifiedRec = E.makeEvidenceRecord({
  goalId: "g", sessionId: "s", criterionId: "c", criterionText: "run the suite",
  kind: "cmd", raw: ev, status: "verified", result: { exit: 0 },
  evidenceSha: E.sha256short(ev), fileShas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
});

await check("exact fingerprint match -> cache HIT", async () => {
  const hit = E.findCachedVerified([verifiedRec], fp());
  assert(hit && hit.status === "verified", "identical fp reuses verified record");
});

await check("criterion text drift -> MISS (must re-run)", async () => {
  assert(!E.findCachedVerified([verifiedRec], fp({ criterion_text_sha: E.criterionTextSha("run the suite NOW") })), "text drift misses");
});

await check("evidence expression drift -> MISS", async () => {
  assert(!E.findCachedVerified([verifiedRec], fp({ evidence_sha: E.sha256short("cmd:npm run other") })), "different cmd misses");
});

await check("declared input file sha drift -> MISS (code changed)", async () => {
  assert(!E.findCachedVerified([verifiedRec], fp({ file_shas: { "src/a.ts": "sha-a2", "src/b.ts": "sha-b" } })), "changed input misses");
});

await check("different input file SET (extra/fewer) -> MISS", async () => {
  assert(!E.findCachedVerified([verifiedRec], fp({ file_shas: { "src/a.ts": "sha-a" } })), "fewer inputs misses");
  assert(!E.findCachedVerified([verifiedRec], fp({ file_shas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b", "src/c.ts": "sha-c" } })), "extra input misses");
});

await check("a FAILED record is never a cache hit", async () => {
  const failedRec = E.makeEvidenceRecord({
    goalId: "g", sessionId: "s", criterionId: "c", criterionText: "run the suite",
    kind: "cmd", raw: ev, status: "failed", result: { exit: 1 },
    evidenceSha: E.sha256short(ev), fileShas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
  });
  assert(!E.findCachedVerified([failedRec], fp()), "failed record not reused");
});

await check("latest verified wins among multiple matches", async () => {
  const older = E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "c", criterionText: "run the suite", kind: "cmd", raw: ev, status: "verified", result: { exit: 0, stdout_sha: "old" }, evidenceSha: E.sha256short(ev), fileShas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" } });
  const newer = E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "c", criterionText: "run the suite", kind: "cmd", raw: ev, status: "verified", result: { exit: 0, stdout_sha: "new" }, evidenceSha: E.sha256short(ev), fileShas: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" } });
  const hit = E.findCachedVerified([older, newer], fp());
  assert(hit && hit.result.stdout_sha === "new", "returns the most recent matching verified record");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal dedup).`
  : `FAIL — ${failures.length}/${total} checks failed (goal dedup).`);
process.exit(failures.length === 0 ? 0 : 1);
