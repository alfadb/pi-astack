#!/usr/bin/env node
/**
 * Smoke: goal v1 FULL loop with REAL execution (Q4 acceptance, logic level).
 * Drives the exact runGoalCheck composition — real child-process spawn to
 * produce evidence, real fs drift to trigger stale — then renders the
 * injection hot-zone and asserts claim-vs-verified. The pi appendEntry is
 * the only piece stubbed (we collect events into an array, as the session
 * tree would). A passing run = the two-books loop really works end to end.
 */
import fs from "node:fs";
import os from "node:os";
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
const X = await jiti.import(`${repoRoot}/extensions/goal/exec.ts`);

console.log("goal v1 — full loop, real execution");

// The runGoalCheck core, minus pi/session plumbing: locate criterion in a real
// plan.md, really run the cmd, build the evidence record. Returns {record}.
async function goalCheck(docPath, cwd, criterionId, evidence, inputs = []) {
  const planText = fs.readFileSync(docPath, "utf-8");
  const { criteria } = E.parsePlanCriteria(planText);
  const crit = criteria.find((c) => c.id === criterionId);
  assert(crit, `criterion ${criterionId} present in plan`);
  const m = /^(cmd|file|git):([\s\S]+)$/.exec(evidence.trim());
  assert(m, "evidence parses");
  const fileShas = {};
  for (const p of inputs) { const sha = X.fileContentSha(p, cwd); if (sha) fileShas[p] = sha; }
  let status, result;
  if (m[1] === "cmd") {
    const out = await X.runEvidenceCmd(m[2].trim(), { cwd });
    status = out.status; result = { exit: out.exit, stdout_sha: out.stdout_sha };
  } else {
    const f = X.resolveFileFacts(m[2].trim(), cwd);
    status = f.exists && (f.size ?? 0) > 0 ? "verified" : "failed";
    result = { content_sha: f.content_sha };
    if (f.content_sha) fileShas[m[2].trim()] = f.content_sha;
  }
  return E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: crit.id, criterionText: crit.text, kind: m[1], raw: evidence, status, result, evidenceSha: E.sha256short(evidence), fileShas });
}
function asEvent(rec) { return { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: rec }; }
function render(docPath, branch, cwd) {
  const { criteria, missingId } = E.parsePlanCriteria(fs.readFileSync(docPath, "utf-8"));
  const xc = E.crossCheck(criteria, E.replayGoalEvidenceEvents(branch), { currentFileSha: (p) => X.fileContentSha(p, cwd) });
  return { xc, block: E.renderCriteriaHotzone(xc), missingId };
}

await check("real cmd pass -> [x]; real cmd fail -> stays [!]; no check -> [!]", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e-"));
  const docPath = path.join(cwd, "plan.md");
  fs.writeFileSync(docPath, [
    "# 目标: e2e",
    "- [x] (pass) a real passing command",
    "- [x] (fail) a real failing command",
    "- [x] (none) claimed, never checked",
  ].join("\n"));

  const branch = [];
  // really run a passing command
  branch.push(asEvent(await goalCheck(docPath, cwd, "pass", "cmd:true")));
  // really run a failing command -> failed evidence (NOT verified)
  branch.push(asEvent(await goalCheck(docPath, cwd, "fail", "cmd:false")));
  // (none) gets no goal_check at all

  const { xc, block } = render(docPath, branch, cwd);
  assert(/\[x\] \(pass\)/.test(block), "pass verified by real exit 0");
  assert(/\[!\] \(fail\)/.test(block), "fail NOT verified (real exit 1) -> [!]");
  assert(/\[!\] \(none\)/.test(block), "unchecked claim -> [!]");
  assert(xc.claimed === 3 && xc.verified === 1, `claimed3/verified1 (got v=${xc.verified})`);
});

await check("real file drift -> verified [x] goes stale on next render (G6)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e2-"));
  const docPath = path.join(cwd, "plan.md");
  fs.writeFileSync(docPath, ["# 目标: drift", "- [x] (impl) feature implemented in mod.ts"].join("\n"));
  fs.writeFileSync(path.join(cwd, "mod.ts"), "export const v = 1;");

  const branch = [];
  // verify with mod.ts declared as an input (fingerprint captured)
  branch.push(asEvent(await goalCheck(docPath, cwd, "impl", "cmd:rg -q v mod.ts", ["mod.ts"])));
  assert(/\[x\] \(impl\)/.test(render(docPath, branch, cwd).block), "verified while mod.ts unchanged");

  // drift the implementation file
  fs.writeFileSync(path.join(cwd, "mod.ts"), "export const v = 2; // changed");
  const after = render(docPath, branch, cwd);
  assert(after.xc.stale === 1 && after.xc.verified === 0, `impl went stale after real file drift (stale=${after.xc.stale})`);
  assert(after.block.includes("过期"), "stale rendered with note");
});

await check("text drift -> stale; re-check with new text -> fresh again", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-e2e3-"));
  const docPath = path.join(cwd, "plan.md");
  fs.writeFileSync(docPath, ["# 目标: textdrift", "- [x] (c) do thing exactly"].join("\n"));
  let branch = [asEvent(await goalCheck(docPath, cwd, "c", "cmd:true"))];
  assert(/\[x\] \(c\)/.test(render(docPath, branch, cwd).block), "verified with original wording");

  // edit the criterion wording -> stale (anti "edit wording keep green check")
  fs.writeFileSync(docPath, ["# 目标: textdrift", "- [x] (c) do thing exactly AND MORE"].join("\n"));
  assert(render(docPath, branch, cwd).xc.stale === 1, "wording edit -> stale");

  // re-check against the new wording -> fresh again
  branch.push(asEvent(await goalCheck(docPath, cwd, "c", "cmd:true")));
  assert(render(docPath, branch, cwd).xc.verified === 1, "re-check restores verified");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal e2e, real execution).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
