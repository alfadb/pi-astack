#!/usr/bin/env node
/**
 * Smoke: goal v1 evidence ledger + plan.md parser + cross-check (G1/G2/G5/G6).
 * Pure logic (extensions/goal/evidence.ts) via jiti — no extension host.
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

console.log("goal v1 — evidence ledger / parser / cross-check");

// helper to wrap an evidence record as a session-tree custom entry
function ev(rec) { return { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: rec }; }
function rec(over = {}) {
  return E.makeEvidenceRecord({
    goalId: "g-1", sessionId: "s-1", criterionId: "c1", criterionText: "do the thing",
    kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0, stdout_sha: "aa" },
    ...over,
  });
}

// G1: fold keeps full append history per criterion (incl failures), latest verified wins
await check("G1 replayGoalEvidenceEvents: per-criterion append history, failures kept", async () => {
  const r1 = rec({ status: "failed", result: { exit: 1 } });
  const r2 = rec({ status: "verified", result: { exit: 0, stdout_sha: "bb" } });
  const r3 = E.makeEvidenceRecord({ goalId: "g-1", sessionId: "s-1", criterionId: "c2", criterionText: "other", kind: "cmd", raw: "cmd:x", status: "verified", result: { exit: 0 } });
  const entries = [
    { type: "message", role: "user" },
    ev(r1), { type: "custom", customType: "other-ext", data: { criterion_id: "c1" } }, ev(r2), ev(r3),
    { type: "custom", customType: E.GOAL_EVIDENCE_EVENT_TYPE, data: { nope: true } }, // malformed -> skipped
  ];
  const m = E.replayGoalEvidenceEvents(entries);
  assert(m.get("c1").length === 2, `c1 keeps both records (got ${m.get("c1").length})`);
  assert(m.get("c1")[0].status === "failed" && m.get("c1")[1].status === "verified", "order preserved, failure retained");
  assert(m.get("c2").length === 1, "c2 separate");
  const lv = E.latestVerified(m.get("c1"));
  assert(lv && lv.result.stdout_sha === "bb", "latestVerified = last verified, not the failure");
  assert(E.latestVerified([rec({ status: "failed" })]) === undefined, "only-failed -> no verified");
});

// G6: staleness on criterion text drift / input file drift
await check("G6 isEvidenceStale: text drift and input-file drift", async () => {
  const r = rec({ criterionText: "run smoke X", fileShas: { "src/a.ts": "sha-a" } });
  assert(E.isEvidenceStale(r, { criterion_text_sha: E.criterionTextSha("run smoke X"), file_shas: { "src/a.ts": "sha-a" } }) === false, "same text+input -> fresh");
  assert(E.isEvidenceStale(r, { criterion_text_sha: E.criterionTextSha("run smoke Y") }) === true, "criterion text changed -> stale");
  assert(E.isEvidenceStale(r, { criterion_text_sha: E.criterionTextSha("run smoke X"), file_shas: { "src/a.ts": "sha-DIFFERENT" } }) === true, "input file sha changed -> stale");
  // cosmetic whitespace reflow must NOT invalidate (same files supplied)
  assert(E.isEvidenceStale(r, { criterion_text_sha: E.criterionTextSha("run   smoke X  "), file_shas: { "src/a.ts": "sha-a" } }) === false, "whitespace reflow tolerated");
  // a record with declared inputs but NO current resolution -> conservative stale
  assert(E.isEvidenceStale(r, { criterion_text_sha: E.criterionTextSha("run smoke X") }) === true, "unresolved declared input -> conservative stale");
});

// G5: parser extracts [ ]/[x]/[~] + (id); missing id surfaced; duplicates flagged
await check("G5 parsePlanCriteria: marks, ids, missing-id, duplicates", async () => {
  const plan = [
    "# 目标: x",
    "## 验收标准",
    "- [ ] (ev) build evidence module — 证据: cmd:`npm run smoke:goal-evidence`",
    "- [x] (parser) parse plan",
    "- [~] (xcheck) cross-check done but unverified",
    "* [X] (exec) uppercase X normalised",
    "- [ ] no id here",
    "- [x] (parser) duplicate id line",
    "not a criterion line",
  ].join("\n");
  const { criteria, missingId, duplicateIds } = E.parsePlanCriteria(plan);
  assert(criteria.length === 5, `5 id'd criteria (got ${criteria.length})`);
  assert(criteria[0].id === "ev" && criteria[0].rawMark === " ", "ev todo");
  assert(criteria[1].id === "parser" && criteria[1].rawMark === "x", "parser claim");
  assert(criteria[2].rawMark === "~", "xcheck done-unverified");
  assert(criteria[3].id === "exec" && criteria[3].rawMark === "x", "uppercase X -> x, * bullet");
  assert(missingId.length === 1 && missingId[0].text === "no id here", "missing-id surfaced");
  assert(duplicateIds.includes("parser"), "duplicate id flagged");
  assert(criteria[0].text.startsWith("build evidence module"), "text after (id) captured");
});

// G2: cross-check renders verified/[!]/stale; claim != verified
await check("G2 crossCheck: verified / unverified([!]) / stale / counts", async () => {
  const plan = [
    "- [x] (a) verified one",
    "- [x] (b) claimed but no evidence",
    "- [x] (c) verified then text drifted",
    "- [~] (d) done unverified",
    "- [ ] (e) todo",
  ].join("\n");
  const { criteria } = E.parsePlanCriteria(plan);
  const m = new Map();
  m.set("a", [E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "a", criterionText: "verified one", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })]);
  m.set("c", [E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: "c", criterionText: "ORIGINAL TEXT", kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })]);
  const xc = E.crossCheck(criteria, m);
  const byId = Object.fromEntries(xc.rendered.map((r) => [r.id, r]));
  assert(byId.a.display === "verified" && byId.a.glyph === "[x]", "a verified");
  assert(byId.b.display === "unverified" && byId.b.glyph === "[!]", "b unverified -> [!]");
  assert(byId.c.display === "stale" && byId.c.glyph === "[!]", "c stale (text drifted from snapshot)");
  assert(byId.d.display === "done-unverified" && byId.e.display === "todo", "d/e passthrough");
  assert(xc.claimed === 3 && xc.verified === 1 && xc.unverified === 1 && xc.stale === 1, `counts claimed3/verified1/unverified1/stale1 got ${JSON.stringify({c:xc.claimed,v:xc.verified,u:xc.unverified,s:xc.stale})}`);
});

// hot-zone render: summary + budget (drop verified first)
await check("renderCriteriaHotzone: claimed|verified summary + over-budget folds verified", async () => {
  const plan = Array.from({ length: 40 }, (_, i) => `- [x] (v${i}) verified criterion number ${i} with some length`).join("\n")
    + "\n- [!]\n- [ ] (todo1) an unverified-driving todo line";
  const { criteria } = E.parsePlanCriteria(plan);
  const m = new Map();
  for (const c of criteria) if (c.id.startsWith("v")) m.set(c.id, [E.makeEvidenceRecord({ goalId: "g", sessionId: "s", criterionId: c.id, criterionText: c.text, kind: "cmd", raw: "cmd:true", status: "verified", result: { exit: 0 } })]);
  const xc = E.crossCheck(criteria, m);
  const block = E.renderCriteriaHotzone(xc, 400);
  assert(block.includes("claimed") && block.includes("verified"), "summary present");
  assert(block.length <= 600, `respects budget-ish (len=${block.length})`);
  assert(block.includes("todo1"), "todo line survives (not folded)");
  assert(block.includes("已折叠"), "over-budget marker present, verified folded");
});

// normalize: forged/torn record rejected
await check("normalizeEvidenceRecord: rejects malformed, coerces status", async () => {
  assert(E.normalizeEvidenceRecord(null) === null, "null -> null");
  assert(E.normalizeEvidenceRecord({ kind: "cmd" }) === null, "no criterion_id -> null");
  assert(E.normalizeEvidenceRecord({ criterion_id: "c", kind: "bogus" }) === null, "bad kind -> null");
  const n = E.normalizeEvidenceRecord({ criterion_id: "c", kind: "cmd", status: "weird", input_fp: { criterion_text_sha: "z" } });
  assert(n && n.status === "failed", "unknown status coerced to failed (conservative)");
});

// section extraction (current-state + decision-log) for the hot-zone
await check("extractPlanSections: current-state block + decision-log lines", async () => {
  const plan = [
    "# 目标: x",
    "## 验收标准",
    "- [ ] (a) thing",
    "## 当前状态",
    "- 方案: approach B",
    "- 下一步: write parser",
    "## 决策日志",
    "- T1 试 A 失败 转 B",
    "- T2 改用 fold",
  ].join("\n");
  const s = E.extractPlanSections(plan);
  assert(/方案: approach B/.test(s.currentState) && /下一步: write parser/.test(s.currentState), "current state captured");
  assert(!/验收标准/.test(s.currentState || ""), "state stops at next heading");
  assert(s.recentDecisions.length === 2 && /T2 改用 fold/.test(s.recentDecisions[1]), "decisions captured");
  const empty = E.extractPlanSections("# 目标: x\n- [ ] (a) y");
  assert(empty.currentState === undefined && empty.recentDecisions.length === 0, "absent sections -> empty");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal evidence).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
