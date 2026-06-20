#!/usr/bin/env node
/**
 * Smoke: goal v2 judge-ev — the auto-continue judge consumes the cross-check
 * ledger (summarizeLedgerForJudge) and counts ONLY system-verified criteria,
 * never a bare [x]. Pure logic (evidence.ts + judge.ts) via jiti.
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
const J = await jiti.import(`${repoRoot}/extensions/goal/judge.ts`);

console.log("goal v2 — judge consumes evidence ledger");

function ev(rec) { return { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: rec }; }

await check("summarizeLedgerForJudge groups verified / unverified[!] / stale", async () => {
  const plan = [
    "## 验收标准",
    "- [x] (a) verified one",
    "- [x] (b) claimed but no evidence",
    "- [x] (c) stale one",
    "- [ ] (d) still todo",
  ].join("\n");
  const { criteria } = E.parsePlanCriteria(plan);
  const branch = [
    ev(E.makeEvidenceRecord({ goalId: "g-1", sessionId: "s", criterionId: "a", criterionText: "verified one", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })),
    // c recorded against OLD text -> current text "stale one" drifts -> stale
    ev(E.makeEvidenceRecord({ goalId: "g-1", sessionId: "s", criterionId: "c", criterionText: "OLD c wording", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })),
  ];
  const xc = E.crossCheck(criteria, E.replayGoalEvidenceEvents(branch));
  assert(xc.verified === 1 && xc.unverified === 1 && xc.stale === 1, `xc counts: ${JSON.stringify(xc)}`);
  const s = E.summarizeLedgerForJudge(xc);
  assert(/\[verified\] \(a\)/.test(s), "verified group has a");
  assert(/\[!\] \(b\)/.test(s), "unverified group has b");
  assert(/\[stale\] \(c\)/.test(s), "stale group has c");
  assert(/ONLY verified/.test(s), "summary tells judge only verified counts");
});

await check("buildGoalJudgePrompt injects the EVIDENCE LEDGER block when provided", async () => {
  const ledger = "system-verified 1 / claimed 3\n  [verified] (a) thing";
  const prompt = J.buildGoalJudgePrompt({
    objective: "do it", successCriteria: [], evidenceLedger: ledger,
    recentTranscript: "", continuationsUsed: 0, maxContinuations: 5,
  });
  assert(/## EVIDENCE LEDGER/.test(prompt), "prompt has ledger header");
  assert(prompt.includes(ledger), "prompt embeds the ledger summary");
  assert(/ONLY when it appears as \[verified\]/.test(prompt), "prompt forbids achieved on bare [x]");
});

await check("buildGoalJudgePrompt omits the ledger section when absent (backward compatible)", async () => {
  const prompt = J.buildGoalJudgePrompt({
    objective: "do it", successCriteria: ["x"],
    recentTranscript: "hi", continuationsUsed: 1, maxContinuations: 5,
  });
  assert(!/EVIDENCE LEDGER/.test(prompt), "no ledger section without input");
  assert(/continuations used: 1\/5/.test(prompt), "rest of prompt intact");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal judge-ev).`
  : `FAIL — ${failures.length}/${total} checks failed (goal judge-ev).`);
process.exit(failures.length === 0 ? 0 : 1);
