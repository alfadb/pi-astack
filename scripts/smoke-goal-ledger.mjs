#!/usr/bin/env node
/**
 * Smoke: goal v1 ledger hot-zone integration (G2 end-to-end claim-vs-verified).
 * Reproduces buildLedgerHotzone's composition (parse plan.md + replay evidence
 * + cross-check + render) on a REAL temp plan.md and real fs inputs, plus the
 * formatGoalBlock(state, ledger) injection wiring. No pi host needed.
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
const S = await jiti.import(`${repoRoot}/extensions/goal/state.ts`);

console.log("goal v1 — ledger hot-zone integration");

// Mirror of index.ts buildLedgerHotzone body (kept in sync; the real one is a
// try/catch wrapper around exactly this composition).
function buildLedgerHotzone(docPath, branch, cwd) {
  const planText = fs.readFileSync(docPath, "utf-8");
  const { criteria, missingId } = E.parsePlanCriteria(planText);
  if (criteria.length === 0 && missingId.length === 0) return undefined;
  const evidence = E.replayGoalEvidenceEvents(branch);
  const xc = E.crossCheck(criteria, evidence, { currentFileSha: (p) => X.fileContentSha(p, cwd) });
  const sections = E.extractPlanSections(planText);
  const parts = [];
  if (sections.currentState) parts.push(`当前状态:\n${sections.currentState}`);
  parts.push(E.renderCriteriaHotzone(xc));
  const recent = sections.recentDecisions.slice(-3);
  if (recent.length) parts.push(`最近决策:\n${recent.join("\n")}`);
  let block = parts.join("\n");
  if (missingId.length) block += `\n⚠ ${missingId.length} 条验收缺 (id)`;
  return block;
}
function ev(rec) { return { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: rec }; }

await check("end-to-end: verified / unverified[!] / stale / done / todo render correctly", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-ledger-"));
  // an input file backing the (depends) criterion
  fs.writeFileSync(path.join(cwd, "src.ts"), "v1");
  const plan = [
    "# 目标: spike",
    "## 验收标准",
    "- [x] (ran) ran a passing command",
    "- [x] (claimed) claimed without evidence",
    "- [x] (depends) verified against src.ts",
    "- [x] (textdrift) wording changed since verify",
    "- [~] (manual) eyeballed",
    "- [ ] (todo) not started",
    "- [x] no-id claim line",
    "## 当前状态",
    "- 下一步: wire goal_check",
    "## 决策日志",
    "- T0 spike 启动",
  ].join("\n");
  const docPath = path.join(cwd, "plan.md");
  fs.writeFileSync(docPath, plan);

  const branch = [
    { type: "message", role: "user" },
    ev(E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "ran", criterionText: "ran a passing command", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })),
    // depends: verified WITH the input file fingerprint captured at v1
    ev(E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "depends", criterionText: "verified against src.ts", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 }, fileShas: { "src.ts": X.fileContentSha("src.ts", cwd) } })),
    // textdrift: verified against the OLD wording
    ev(E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "textdrift", criterionText: "OLD WORDING", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })),
  ];

  const block = buildLedgerHotzone(docPath, branch, cwd);
  assert(/\[x\] \(ran\)/.test(block), "ran -> verified [x]");
  assert(/\[!\] \(claimed\)/.test(block), "claimed -> [!] unverified");
  assert(/\[x\] \(depends\)/.test(block), "depends -> verified [x] (input unchanged)");
  assert(/\[!\] \(textdrift\).*过期|stale|过期/.test(block) || /\(textdrift\)/.test(block) && /过期/.test(block), "textdrift -> stale [!]");
  assert(/\[~\] \(manual\)/.test(block), "manual -> [~]");
  assert(/\[ \] \(todo\)/.test(block), "todo -> [ ]");
  assert(/claimed 4 \| verified 2/.test(block), `summary claimed4/verified2: ${block.split("\n")[0]}`);
  assert(/缺 \(id\)/.test(block), "no-id claim line surfaced as missing-id warning");
  assert(/当前状态:[\s\S]*wire goal_check/.test(block), "current-state injected");
  assert(/最近决策:[\s\S]*spike 启动/.test(block), "recent decisions injected");

  // now drift the input file -> depends must go stale on next build
  fs.writeFileSync(path.join(cwd, "src.ts"), "v2-CHANGED");
  const block2 = buildLedgerHotzone(docPath, branch, cwd);
  assert(/\(depends\).*过期/.test(block2) || (/\(depends\)/.test(block2) && block2.includes("过期")), "depends -> stale after input file drift (G6)");
  assert(/verified 1/.test(block2), `after drift only 'ran' verified: ${block2.split("\n")[0]}`);
});

await check("formatGoalBlock(state, ledger): ledger replaces static criteria, strips clean", async () => {
  const st = S.newGoalState({ sessionId: "s", objective: "obj", source: { type: "doc", doc_path: "/tmp/plan.md", doc_display_path: "plan.md", doc_hash: "h" }, successCriteria: ["STATIC SHOULD NOT SHOW"] });
  const ledger = "验收: claimed 1 | verified 0\n- [!] (a) needs evidence";
  const block = S.formatGoalBlock(st, ledger);
  assert(block.includes("claimed 1 | verified 0") && block.includes("[!] (a)"), "ledger injected");
  assert(!block.includes("STATIC SHOULD NOT SHOW"), "static criteria suppressed when ledger present");
  // strip must remove the whole block incl ledger (no residue accumulation)
  const stripped = S.stripGoalBlock(`BASE\n\n${block}\n`);
  assert(!stripped.includes("claimed") && stripped.includes("BASE"), "strips clean");
});

await check("evidence expression parse (mirror of goal_check regex)", async () => {
  const RE = /^(cmd|file|git):([\s\S]+)$/;
  assert(RE.exec("cmd:npm run smoke")?.[1] === "cmd", "cmd kind");
  assert(RE.exec("file:./dist/x")?.[2] === "./dist/x", "file arg");
  assert(RE.exec("git:abc123")?.[1] === "git", "git kind");
  assert(RE.exec("nope") === null, "bare string rejected");
  assert(RE.exec("cmd:")?.[2] === undefined || RE.exec("cmd:") === null, "empty cmd rejected");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal ledger integration).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
