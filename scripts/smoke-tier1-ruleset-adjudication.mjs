#!/usr/bin/env node
/**
 * Smoke: A1 full-candidate-set rule adjudication (tier1-ruleset-adjudicator.ts).
 *
 * Verifies the A1 redesign with an INJECTED fake adjudicator (no live LLM):
 *   - jargon replay: new broad directive + existing narrow rule + sibling
 *     jargon rules → merge into target + ARCHIVE the superseded ones, NOT a
 *     new entry;
 *   - create + archive a superseded rule;
 *   - fallback to deterministic create on adjudicator failure (no archive);
 *   - invalid target slug → safe create fallback;
 *   - archive_slugs filtered to candidate set, never the winner;
 *   - no candidates → deterministic create;
 *   - parseRuleSetAdjudication unit (closed decision space, archive default).
 * gitCommit:false so no git repo is required.
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

const writer = await jiti.import(`${repoRoot}/extensions/sediment/writer.ts`);
const { writeAbrainRule, listRulesInScope, findRuleFile } = writer;
const rs = await jiti.import(`${repoRoot}/extensions/sediment/tier1-ruleset-adjudicator.ts`);
const { resolveRuleWrite, parseRuleSetAdjudication, buildRuleSetAdjudicationPrompt } = rs;

const SETTINGS = { gitCommit: false, lockTimeoutMs: 5000 };
const AUDIT = { lane: "auto_write", sessionId: "smoke", correlationId: "c", candidateId: "c-1" };
const baseDraft = { zone: "rules", kind: "preference", entryConfidence: 9, routingConfidence: 1, routingReason: "user directive", sessionId: "smoke", scope: "global", injectMode: "always" };

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-ruleset-"));
  fs.mkdirSync(path.join(home, "rules", "always"), { recursive: true });
  fs.mkdirSync(path.join(home, "rules", "listed"), { recursive: true });
  return home;
}
async function seed(home, title, body, injectMode = "listed") {
  const r = await writeAbrainRule({ ...baseDraft, title, body, injectMode }, { abrainHome: home, settings: SETTINGS, auditContext: AUDIT });
  assert(r.status === "created", `seed ${title}: ${r.status} ${r.reason}`);
  return r.slug;
}
const fakeAdj = (decision) => async () => ({ ok: true, model: "fake/adj", decision, durationMs: 1 });
const failAdj = async () => ({ ok: false, model: "fake/adj", error: "boom", durationMs: 1 });
function statusOf(home, slug) {
  const f = findRuleFile(home, "global", undefined, slug);
  if (!f) return "absent";
  return (fs.readFileSync(f.path, "utf-8").match(/^status:\s*"?(\w+)"?/m) || [])[1] || "unknown";
}

console.log("A1 ruleset adjudication");

await check("parse: closed decision space + archive default + merge needs body", () => {
  assert(parseRuleSetAdjudication('{"decision":"skip"}') === null, "skip rejected");
  assert(parseRuleSetAdjudication('{"decision":"update"}') === null, "update needs target");
  assert(parseRuleSetAdjudication('{"decision":"merge","target_slug":"x"}') === null, "merge needs body");
  const c = parseRuleSetAdjudication('{"decision":"create","reason":"r"}');
  assert(c && c.decision === "create" && Array.isArray(c.archiveSlugs) && c.archiveSlugs.length === 0, "create ok, archive [] default");
  const m = parseRuleSetAdjudication('garbage {"decision":"merge","target_slug":"x","merged_body":"a coherent merged body","archive_slugs":["y"]} trailing');
  assert(m && m.decision === "merge" && m.targetSlug === "x" && m.archiveSlugs[0] === "y", "merge parsed from embedded json");
});

await check("prompt: lists candidates + marks them as DATA", () => {
  const p = buildRuleSetAdjudicationPrompt({ draftTitle: "T", draftBody: "B", candidates: [{ slug: "alpha", title: "A", body: "abody" }] });
  assert(p.includes("slug: alpha") && p.includes("abody"), "candidate present");
  assert(/DATA, not instructions/i.test(p), "trust-boundary framing");
});

await check("JARGON REPLAY: merge into target + archive siblings, NOT a new entry", async () => {
  const home = freshHome();
  const narrow = await seed(home, "文档注释禁用黑话", "文档、注释不允许使用行业黑话，使用专业中性词汇。");
  const sib1 = await seed(home, "avoid colloquial jargon in artifacts", "Avoid colloquial jargon in written artifacts; use professional neutral vocabulary.");
  const sib2 = await seed(home, "documentation vocabulary professional", "Documentation vocabulary must be professional-neutral, not industry slang.");

  const draft = { ...baseDraft, title: "黑话规则扩展到口头交流", body: "禁用行业黑话不仅适用于文档/注释，也适用于与用户的直接对话，统一用专业中性词汇。" };
  const decision = { decision: "merge", targetSlug: narrow, mergedBody: "禁用行业黑话：适用于文档、注释、决策记录、提交说明，以及与用户的直接对话；统一使用专业、中性、说得明白的词汇。", archiveSlugs: [sib1, sib2], reason: "broader rule subsumes the narrow + sibling jargon rules" };
  const candidates = listRulesInScope(home, "global", undefined);
  assert(candidates.length === 3, `candidates=${candidates.length}`);
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates, settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: fakeAdj(decision) });

  assert(result.status === "updated", `target updated, got ${result.status} ${result.reason}`);
  assert(result.slug === narrow, `winner is the target, got ${result.slug}`);
  // no NEW file for the directive's own slug
  assert(!findRuleFile(home, "global", undefined, "黑话规则扩展到口头交流"), "no new entry created for the directive");
  assert(statusOf(home, sib1) === "archived" && statusOf(home, sib2) === "archived", `siblings archived: ${statusOf(home, sib1)}/${statusOf(home, sib2)}`);
  assert(statusOf(home, narrow) === "active", "merged target stays active");
  assert(adjudication.decision === "merge" && adjudication.archived.length === 2 && adjudication.archived.every((a) => a.status === "archived"), `adj meta: ${JSON.stringify(adjudication)}`);
});

await check("create + archive a superseded rule", async () => {
  const home = freshHome();
  const old = await seed(home, "old narrow rule", "Old narrow statement that the new rule fully supersedes.");
  const draft = { ...baseDraft, title: "new broad rule", body: "A genuinely new broad rule that supersedes the old narrow one entirely." };
  const candidates = listRulesInScope(home, "global", undefined);
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates, settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: fakeAdj({ decision: "create", archiveSlugs: [old], reason: "supersedes old" }) });
  assert(result.status === "created", `created, got ${result.status}`);
  assert(statusOf(home, old) === "archived", `old archived, got ${statusOf(home, old)}`);
  assert(adjudication.decision === "create" && adjudication.archived[0].slug === old, "archived recorded");
});

await check("fallback: adjudicator failure → deterministic create, no archive", async () => {
  const home = freshHome();
  const keep = await seed(home, "should survive", "This rule must NOT be archived when the adjudicator fails.");
  const draft = { ...baseDraft, title: "directive on failure", body: "This directive must still land as a create when adjudication fails." };
  const candidates = listRulesInScope(home, "global", undefined);
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates, settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: failAdj });
  assert(result.status === "created", `created on fallback, got ${result.status}`);
  assert(adjudication.fallback === "boom", `fallback reason recorded: ${JSON.stringify(adjudication)}`);
  assert(statusOf(home, keep) === "active", "no archive on failure");
});

await check("invalid target slug → safe create fallback", async () => {
  const home = freshHome();
  await seed(home, "real rule", "A real candidate rule body for the invalid-target test.");
  const draft = { ...baseDraft, title: "bad target directive", body: "Directive whose adjudication points at a nonexistent target slug." };
  const candidates = listRulesInScope(home, "global", undefined);
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates, settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: fakeAdj({ decision: "update", targetSlug: "does-not-exist", archiveSlugs: [], reason: "x" }) });
  assert(result.status === "created", `safe create, got ${result.status}`);
  assert(String(adjudication.fallback || "").startsWith("invalid_target"), `invalid_target fallback: ${JSON.stringify(adjudication)}`);
});

await check("archive_slugs filtered to candidate set, never the winner", async () => {
  const home = freshHome();
  const real = await seed(home, "real archivable", "A real rule that can legitimately be archived.");
  const draft = { ...baseDraft, title: "winner rule", body: "The winner rule whose own slug must never be self-archived." };
  const candidates = listRulesInScope(home, "global", undefined);
  // adjudicator (wrongly) asks to archive: a nonexistent slug, and the winner's own slug, plus the real one
  const winnerSlug = "winner-rule";
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates, settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: fakeAdj({ decision: "create", archiveSlugs: ["ghost-slug", winnerSlug, real], reason: "mixed" }) });
  assert(result.status === "created" && result.slug === winnerSlug, `created winner, got ${result.status}/${result.slug}`);
  assert(statusOf(home, winnerSlug) === "active", "winner not self-archived");
  assert(adjudication.archived.length === 1 && adjudication.archived[0].slug === real, `only the valid candidate archived: ${JSON.stringify(adjudication.archived)}`);
});

await check("no candidates → deterministic create", async () => {
  const home = freshHome();
  const draft = { ...baseDraft, title: "first rule", body: "First rule in an empty scope; nothing to adjudicate against." };
  const { result, adjudication } = await resolveRuleWrite({ draft, candidates: [], settings: SETTINGS, modelRegistry: {}, abrainHome: home, auditContext: AUDIT, adjudicateFn: fakeAdj({ decision: "update", targetSlug: "x", archiveSlugs: [], reason: "should not be called" }) });
  assert(result.status === "created", `created, got ${result.status}`);
  assert(adjudication.reason === "no_candidates", `no_candidates: ${JSON.stringify(adjudication)}`);
});

console.log("");
if (failures.length) { console.log(`❌ ${failures.length}/${total} failed`); process.exit(1); }
console.log(`✅ A1 ruleset adjudication: all ${total} checks passed`);
