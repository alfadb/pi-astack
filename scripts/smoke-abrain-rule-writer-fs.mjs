#!/usr/bin/env node
/**
 * Smoke test: ADR 0023 D5 writeAbrainRule orchestration (fs-level).
 *
 * Loads extensions/sediment/writer.ts via jiti (the runtime's own loader, so
 * the full dep tree resolves) and exercises create / lifecycle / lints against
 * a real temp abrain tree. gitCommit:false so no git repo is required.
 *
 * Covers: create (global always + project listed) → file + frontmatter;
 * duplicate reject; INV-R4 kind reject; always over-size AUTO-DEMOTE->listed; INV-R3 budget
 * reject; dry_run; archive (status→archived); delete (unlink).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const { writeAbrainRule, archiveAbrainRule, deleteAbrainRule, findRuleFile } = writer;
const { parseDecision } = await jiti.import(`${repoRoot}/extensions/sediment/curator.ts`);
const { executeCuratorDecisionToBrain } = await jiti.import(`${repoRoot}/extensions/sediment/curator-decision-writer.ts`);

const SETTINGS = { gitCommit: false, lockTimeoutMs: 5000 };
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rule-fs-"));
  fs.mkdirSync(path.join(home, "rules", "always"), { recursive: true });
  fs.mkdirSync(path.join(home, "rules", "listed"), { recursive: true });
  fs.mkdirSync(path.join(home, "projects", "pi-global"), { recursive: true });
  return home;
}
const baseDraft = {
  zone: "rules", kind: "maxim", entryConfidence: 9, routingConfidence: 0.9,
  routingReason: "user said 永远", sessionId: "smoke",
};

console.log("abrain rule writer — fs orchestration (ADR 0023 D5)");

await check("create: global always maxim lands at rules/always/<slug>.md with frontmatter", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Edit not sed", body: "修改文件必须用 edit/write，禁止 sed -i。", tier: "always", scope: "global", hint: "use edit/write, never sed" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created", `status=${r.status} reason=${r.reason}`);
  const fp = path.join(home, "rules", "always", "edit-not-sed.md");
  assert(fs.existsSync(fp), `file at ${fp}`);
  const md = fs.readFileSync(fp, "utf-8");
  assert(md.includes("scope: global") && md.includes('tier: "always"') && md.includes("body_hash:"), "frontmatter shape");
  assert(r.lane === "rules" && r.tier === "always" && r.ruleScope === "global", `result ctx: ${JSON.stringify(r)}`);
});

await check("create: project listed decision lands under projects/<id>/rules/listed", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Design first", body: "本项目：先写设计文档再写代码，这是长期约定。", kind: "decision", tier: "listed", scope: { projectId: "pi-global" }, entryConfidence: 7 },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created", `status=${r.status} reason=${r.reason}`);
  const fp = path.join(home, "projects", "pi-global", "rules", "listed", "design-first.md");
  assert(fs.existsSync(fp), `file at ${fp}; got ${r.path}`);
  assert(r.ruleScope === "project" && r.projectId === "pi-global", JSON.stringify(r));
});

await check("create: duplicate slug rejected", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  const d = { ...baseDraft, title: "Dup", body: "some durable rule body here ok", tier: "always", scope: "global" };
  assert((await writeAbrainRule(d, opts)).status === "created", "first create");
  const r2 = await writeAbrainRule(d, opts);
  assert(r2.status === "rejected" && r2.reason === "duplicate_slug", `dup: ${JSON.stringify(r2)}`);
});

await check("INV-R4: always-tier with kind=fact rejected", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Bad kind", body: "this is a fact not a maxim body", kind: "fact", tier: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason.startsWith("kind_invalid"), `kind reject: ${JSON.stringify(r)}`);
});

await check("always body > 300 AUTO-DEMOTES to listed (T0 panel 2026-06-07; not rejected, never lost)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Too big", body: "x".repeat(301), tier: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created" && r.tier === "listed" && r.demotedFrom === "always", `should demote not reject: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "listed", "too-big.md")), "landed in listed/");
  assert(!fs.existsSync(path.join(home, "rules", "always", "too-big.md")), "not in always/");
  assert(fs.readFileSync(path.join(home, "rules", "listed", "too-big.md"), "utf-8").includes("x".repeat(301)), "full body preserved on disk (listed stores body, injects only a hint)");
});

await check("audit P1-a: malformed tier rejected (no path-join traversal)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Evil tier", body: "tier traversal attempt body content", tier: "../../../../tmp/pwned", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason === "validation_error_tier", `tier reject: ${JSON.stringify(r)}`);
  assert(!fs.existsSync(path.join(home, "..", "..", "..", "..", "tmp", "pwned")), "no file escaped rulesBaseDir");
});

await check("audit P2-1: all-punctuation title falls back to slug 'rule' (no .md dotfile)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "!!!", body: "all punctuation title body content ok", tier: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created" && r.slug === "rule", `slug fallback: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "always", "rule.md")), "rule.md (not .md dotfile)");
  assert(!fs.existsSync(path.join(home, "rules", "always", ".md")), "no degenerate .md dotfile");
});

await check("INV-R3: budget over-cap rejected + suggests archive", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  assert((await writeAbrainRule({ ...baseDraft, title: "First rule", body: "first durable rule body content", tier: "listed", scope: "global", kind: "pattern" }, opts)).status === "created", "seed rule");
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Second rule", body: "second durable rule body content", tier: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: SETTINGS, budgetTokenCap: 1 });
  assert(r.status === "rejected" && r.reason === "budget_exceeded", `budget reject: ${JSON.stringify(r)}`);
  assert(typeof r.budgetTokens === "number" && r.budgetCap === 1 && r.suggestArchiveSlug, `budget detail: ${JSON.stringify(r)}`);
});

await check("dry_run: no file written, status dry_run", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Dry", body: "dry run rule body content here", tier: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS, dryRun: true });
  assert(r.status === "dry_run", `status=${r.status}`);
  assert(!fs.existsSync(path.join(home, "rules", "always", "dry.md")), "no file on dry_run");
});

await check("archive: status -> archived in place (rule stops injecting, file kept)", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  await writeAbrainRule({ ...baseDraft, title: "Veto me", body: "this rule will be vetoed by user", tier: "always", scope: "global" }, opts);
  const r = await archiveAbrainRule("veto-me", "global", undefined, { ...opts, reason: "user said 这条不对" });
  assert(r.status === "archived", `archive status: ${JSON.stringify(r)}`);
  const md = fs.readFileSync(path.join(home, "rules", "always", "veto-me.md"), "utf-8");
  assert(/status:\s*"?archived"?/.test(md), `status archived in file: ${md.split("\n").find((l) => l.startsWith("status"))}`);
  assert(md.includes("| archived |"), "timeline archived entry appended");
});

await check("archive: missing slug -> entry_not_found", async () => {
  const home = freshHome();
  const r = await archiveAbrainRule("nope", "global", undefined, { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason === "entry_not_found", JSON.stringify(r));
});

await check("delete: unlinks the rule file", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  await writeAbrainRule({ ...baseDraft, title: "Gone soon", body: "this rule will be hard-deleted ok", tier: "listed", scope: "global", kind: "pattern" }, opts);
  const found = findRuleFile(home, "global", undefined, "gone-soon");
  assert(found && fs.existsSync(found.path), "exists before delete");
  const r = await deleteAbrainRule("gone-soon", "global", undefined, opts);
  assert(r.status === "deleted", `delete status: ${JSON.stringify(r)}`);
  assert(!fs.existsSync(found.path), "file gone after delete");
});

// ── end-to-end: parseDecision -> dispatch -> rule writer (W0.2 + W2) ─────────
await check("e2e: parseDecision rules-create -> executeCuratorDecisionToBrain -> file", async () => {
  const home = freshHome();
  const decision = parseDecision(JSON.stringify({ op: "create", zone: "rules", tier: "always", rule_scope: "global", rationale: "user said 永远 use edit" }), new Map());
  assert(decision.op === "create" && decision.zone === "rules" && decision.tier === "always" && decision.ruleScope === "global", `decision: ${JSON.stringify(decision)}`);
  const results = await executeCuratorDecisionToBrain({
    decision,
    draft: { title: "Edit only", kind: "maxim", status: "active", confidence: 9, compiledTruth: "修改文件必须用 edit/write，禁止 sed。" },
    projectRoot: home, abrainHome: home, projectId: "pi-global", settings: SETTINGS,
  });
  assert(results[0].status === "created" && results[0].lane === "rules", `e2e create: ${JSON.stringify(results[0])}`);
  assert(fs.existsSync(path.join(home, "rules", "always", "edit-only.md")), "rule file written via dispatch");
});

await check("e2e: project rules-create routes to projects/<id>/rules + archive routes by slug", async () => {
  const home = freshHome();
  const create = parseDecision(JSON.stringify({ op: "create", zone: "rules", tier: "listed", rule_scope: "project" }), new Map());
  await executeCuratorDecisionToBrain({
    decision: create,
    draft: { title: "Proj rule", kind: "decision", status: "active", confidence: 7, compiledTruth: "本项目先写设计文档再写代码长期约定" },
    projectRoot: home, abrainHome: home, projectId: "pi-global", settings: SETTINGS,
  });
  assert(fs.existsSync(path.join(home, "projects", "pi-global", "rules", "listed", "proj-rule.md")), "project rule file");
  // archive routes by findRuleFile (neighbor-lane), decision built directly
  const res = await executeCuratorDecisionToBrain({
    decision: { op: "archive", slug: "proj-rule", reason: "user vetoed" },
    draft: { title: "x", kind: "decision", status: "active", confidence: 5, compiledTruth: "x".repeat(20) },
    projectRoot: home, abrainHome: home, projectId: "pi-global", settings: SETTINGS,
  });
  assert(res[0].status === "archived", `e2e archive routed to rule writer: ${JSON.stringify(res[0])}`);
});

// ── audit round-2 P0: archive/delete roll back on git-commit failure ────────
function gitHomeWithFailingCommit() {
  const home = freshHome();
  execFileSync("git", ["-C", home, "init", "-q"]);
  execFileSync("git", ["-C", home, "config", "user.email", "smoke@test"]);
  execFileSync("git", ["-C", home, "config", "user.name", "smoke"]);
  const hookDir = path.join(home, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return home;
}
const GIT_SETTINGS = { gitCommit: true, lockTimeoutMs: 5000 };

await check("archive: git-commit failure rolls back (file stays active, status rejected)", async () => {
  const home = gitHomeWithFailingCommit();
  // seed without git so a file exists on disk
  await writeAbrainRule({ ...baseDraft, title: "Rollback me", body: "this rule must survive a failed archive commit", tier: "listed", scope: "global", kind: "pattern" }, { abrainHome: home, settings: SETTINGS });
  const fp = path.join(home, "rules", "listed", "rollback-me.md");
  const before = fs.readFileSync(fp, "utf-8");
  const r = await archiveAbrainRule("rollback-me", "global", undefined, { abrainHome: home, settings: GIT_SETTINGS, reason: "x" });
  assert(r.status === "rejected" && r.reason === "git_commit_failed", `archive should reject on git fail: ${JSON.stringify(r)}`);
  assert(fs.existsSync(fp), "file still present after rolled-back archive");
  const after = fs.readFileSync(fp, "utf-8");
  assert(!/status:\s*"?archived"?/.test(after), `status must be restored (not archived): ${after.split("\n").find((l) => l.startsWith("status"))}`);
  assert(after === before, "content byte-identical to pre-archive");
});

await check("delete: git-commit failure restores the unlinked file (status rejected)", async () => {
  const home = gitHomeWithFailingCommit();
  await writeAbrainRule({ ...baseDraft, title: "Keep me", body: "this rule must survive a failed delete commit", tier: "listed", scope: "global", kind: "pattern" }, { abrainHome: home, settings: SETTINGS });
  const fp = path.join(home, "rules", "listed", "keep-me.md");
  const before = fs.readFileSync(fp, "utf-8");
  const r = await deleteAbrainRule("keep-me", "global", undefined, { abrainHome: home, settings: GIT_SETTINGS });
  assert(r.status === "rejected" && r.reason === "git_commit_failed", `delete should reject on git fail: ${JSON.stringify(r)}`);
  assert(fs.existsSync(fp), "unlinked file restored after rolled-back delete");
  assert(fs.readFileSync(fp, "utf-8") === before, "restored content byte-identical");
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nall ok — writeAbrainRule fs orchestration holds (${total} assertions).`);
