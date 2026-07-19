#!/usr/bin/env node
/**
 * Smoke test: ADR 0023 D5 writeAbrainRule orchestration (fs-level).
 *
 * Loads extensions/sediment/writer.ts via jiti (the runtime's own loader, so
 * the full dep tree resolves) and exercises create / lifecycle / lints against
 * a real temp abrain tree. gitCommit:false so no git repo is required.
 *
 * Covers: create (global always + project listed) → file + frontmatter;
 * duplicate reject; INV-R4 kind reject; always over-size AUTO-DEMOTE->listed; budget
 * over-cap advisory telemetry; dry_run; archive (status→archived); delete (unlink).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
const { shouldEscalateToCurator, isTier1Directive } = await jiti.import(`${repoRoot}/extensions/sediment/correction-pipeline.ts`);

const SETTINGS = { gitCommit: false, lockTimeoutMs: 5000 };
const gateSettings = (mode) => ({ ...SETTINGS, tier2RulesLegacyWriteGate: { mode } });
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-rule-fs-"));
  fs.mkdirSync(path.join(home, "rules", "always"), { recursive: true });
  fs.mkdirSync(path.join(home, "rules", "listed"), { recursive: true });
  fs.mkdirSync(path.join(home, "projects", "pi-global"), { recursive: true });
  return home;
}
function auditEvents(home) {
  const auditPath = path.join(home, ".state", "sediment", "audit.jsonl");
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function latestGateEvent(home) {
  return auditEvents(home).filter((e) => e.operation === "tier2_rules_legacy_write_gate").at(-1);
}
function tier2GateContext(operation, extra = {}) {
  return { caller: "curator_decision_writer", operation, ruleScope: "global", slug: "Context Title", ...extra };
}
const baseDraft = {
  zone: "rules", kind: "maxim", entryConfidence: 9, routingConfidence: 0.9,
  routingReason: "user said 永远", sessionId: "smoke",
};

const gitPublicationFixtureMode = process.env.PI_ASTACK_RULE_WRITER_FS_GIT_PUBLICATION_FIXTURE;
if (gitPublicationFixtureMode) {
  if (gitPublicationFixtureMode !== "canonical" && gitPublicationFixtureMode !== "legacy") {
    throw new Error(`unknown git-publication fixture mode: ${gitPublicationFixtureMode}`);
  }
  const expectedCanonical = gitPublicationFixtureMode === "canonical";
  const { canonicalGitRuntimeEnabled, getCanonicalStartupPromise } = await jiti.import(`${repoRoot}/extensions/_shared/canonical-git-runtime.ts`);
  assert(canonicalGitRuntimeEnabled() === expectedCanonical, `fixture settings did not select ${gitPublicationFixtureMode}`);
  const fixtureSettings = { gitCommit: true, lockTimeoutMs: 5000 };

  async function runOperation(operation) {
    const home = freshHome();
    execFileSync("git", ["-C", home, "init", "-q"]);
    execFileSync("git", ["-C", home, "config", "user.email", "smoke@test"]);
    execFileSync("git", ["-C", home, "config", "user.name", "smoke"]);
    // A real HEAD keeps canonical blocking focused on its publication boundary,
    // rather than the unrelated unborn-branch condition.
    fs.writeFileSync(path.join(home, ".gitignore"), ".state/\n");
    execFileSync("git", ["-C", home, "add", ".gitignore"]);
    execFileSync("git", ["-C", home, "commit", "-qm", "fixture base"]);
    if (!expectedCanonical) {
      fs.writeFileSync(path.join(home, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    } else {
      const startup = await getCanonicalStartupPromise({ abrainHome: home });
      assert(startup.startup === "ready", `canonical fixture startup blocked: ${startup.blockedReason}`);
    }

    const slug = operation === "archive" ? "rollback-me" : "keep-me";
    await writeAbrainRule(
      { ...baseDraft, title: operation === "archive" ? "Rollback me" : "Keep me", body: `fixture ${operation} content must remain observable`, injectMode: "listed", scope: "global", kind: "pattern" },
      { abrainHome: home, settings: SETTINGS },
    );
    const filePath = path.join(home, "rules", "listed", `${slug}.md`);
    const before = fs.readFileSync(filePath, "utf-8");
    if (expectedCanonical) fs.writeFileSync(path.join(home, ".git", "index.lock"), "fixture lock\n");
    const result = operation === "archive"
      ? await archiveAbrainRule(slug, "global", undefined, { abrainHome: home, settings: fixtureSettings, reason: "fixture" })
      : await deleteAbrainRule(slug, "global", undefined, { abrainHome: home, settings: fixtureSettings });
    return {
      result,
      existsAfter: fs.existsSync(filePath),
      bytesAfter: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null,
      before,
    };
  }

  const reportPath = process.env.PI_ASTACK_RULE_WRITER_FS_GIT_PUBLICATION_REPORT;
  if (!reportPath) throw new Error("git-publication fixture report path is required");
  const report = { mode: gitPublicationFixtureMode, archive: await runOperation("archive"), delete: await runOperation("delete") };
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  process.exit(0);
}

console.log("abrain rule writer — fs orchestration (ADR 0023 D5)");

await check("create: global always maxim lands at rules/always/<slug>.md with frontmatter", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Edit not sed", body: "修改文件必须用 edit/write，禁止 sed -i。", injectMode: "always", scope: "global", hint: "use edit/write, never sed" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created", `status=${r.status} reason=${r.reason}`);
  const fp = path.join(home, "rules", "always", "edit-not-sed.md");
  assert(fs.existsSync(fp), `file at ${fp}`);
  const md = fs.readFileSync(fp, "utf-8");
  assert(md.includes("scope: global") && md.includes('inject_mode: "always"') && md.includes("body_hash:"), "frontmatter shape");
  assert(r.lane === "rules" && r.injectMode === "always" && r.ruleScope === "global", `result ctx: ${JSON.stringify(r)}`);
});

await check("create: project listed decision lands under projects/<id>/rules/listed", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Design first", body: "本项目：先写设计文档再写代码，这是长期约定。", kind: "decision", injectMode: "listed", scope: { projectId: "pi-global" }, entryConfidence: 7 },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created", `status=${r.status} reason=${r.reason}`);
  const fp = path.join(home, "projects", "pi-global", "rules", "listed", "design-first.md");
  assert(fs.existsSync(fp), `file at ${fp}; got ${r.path}`);
  assert(r.ruleScope === "project" && r.projectId === "pi-global", JSON.stringify(r));
});

await check("create: duplicate slug rejected", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  const d = { ...baseDraft, title: "Dup", body: "some durable rule body here ok", injectMode: "always", scope: "global" };
  assert((await writeAbrainRule(d, opts)).status === "created", "first create");
  const r2 = await writeAbrainRule(d, opts);
  assert(r2.status === "rejected" && r2.reason === "duplicate_slug", `dup: ${JSON.stringify(r2)}`);
});

await check("INV-R4: always-mode with kind=fact rejected", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Bad kind", body: "this is a fact not a maxim body", kind: "fact", injectMode: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason.startsWith("kind_invalid"), `kind reject: ${JSON.stringify(r)}`);
});

await check("always body > 300 AUTO-DEMOTES to listed (T0 panel 2026-06-07; not rejected, never lost)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Too big", body: "x".repeat(301), injectMode: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created" && r.injectMode === "listed" && r.demotedFrom === "always", `should demote not reject: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "listed", "too-big.md")), "landed in listed/");
  assert(!fs.existsSync(path.join(home, "rules", "always", "too-big.md")), "not in always/");
  assert(fs.readFileSync(path.join(home, "rules", "listed", "too-big.md"), "utf-8").includes("x".repeat(301)), "full body preserved on disk (listed injects catalog summary, reads body on demand)");
});

await check("audit P1-a: malformed inject_mode rejected (no path-join traversal)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Evil tier", body: "tier traversal attempt body content", injectMode: "../../../../tmp/pwned", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "rejected" && r.reason === "validation_error_inject_mode", `inject_mode reject: ${JSON.stringify(r)}`);
  assert(!fs.existsSync(path.join(home, "..", "..", "..", "..", "tmp", "pwned")), "no file escaped rulesBaseDir");
});

await check("audit P2-1: all-punctuation title falls back to slug 'rule' (no .md dotfile)", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "!!!", body: "all punctuation title body content ok", injectMode: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS });
  assert(r.status === "created" && r.slug === "rule", `slug fallback: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "always", "rule.md")), "rule.md (not .md dotfile)");
  assert(!fs.existsSync(path.join(home, "rules", "always", ".md")), "no degenerate .md dotfile");
});

await check("#2 dedup: a re-stated rule (near-identical body, different slug) is deduped, not duplicated", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  const a = await writeAbrainRule({ ...baseDraft, title: "Glab rule", body: "git.alfadb.cn 仓库一律用 glab 管理，禁用裸 git/curl API", injectMode: "listed", scope: "global", kind: "preference" }, opts);
  assert(a.status === "created", `seed: ${JSON.stringify(a)}`);
  // restated with reworded title + slug but same essence
  const b = await writeAbrainRule({ ...baseDraft, title: "Use glab for git.alfadb.cn", body: "git.alfadb.cn 仓库一律用 glab 管理，禁用裸 git 和 curl API 调用", injectMode: "listed", scope: "global", kind: "preference" }, opts);
  assert(b.status === "deduped" && b.dedupedAgainst === "glab-rule", `should dedup against glab-rule: ${JSON.stringify(b)}`);
  assert(!fs.existsSync(path.join(home, "rules", "listed", "use-glab-for-git-alfadb-cn.md")), "no duplicate file written");
  // a genuinely different rule is NOT deduped
  const c = await writeAbrainRule({ ...baseDraft, title: "Gh rule", body: "github 仓库一律用 gh 工具管理", injectMode: "listed", scope: "global", kind: "preference" }, opts);
  assert(c.status === "created", `distinct rule must create: ${JSON.stringify(c)}`);
});

await check("budget over-cap is advisory telemetry, not a write rejection", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  assert((await writeAbrainRule({ ...baseDraft, title: "First rule", body: "first durable rule body content", injectMode: "listed", scope: "global", kind: "pattern" }, opts)).status === "created", "seed rule");
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Second rule", body: "second durable rule body content", injectMode: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: SETTINGS, budgetTokenCap: 1 });
  assert(r.status === "created" && r.overSoftBudget === true, `budget advisory create: ${JSON.stringify(r)}`);
  assert(typeof r.budgetTokens === "number" && r.budgetCap === 1, `budget detail: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "listed", "second-rule.md")), "over-budget rule still persisted");
});

await check("dry_run: no file written, status dry_run", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Dry", body: "dry run rule body content here", injectMode: "always", scope: "global" },
    { abrainHome: home, settings: SETTINGS, dryRun: true });
  assert(r.status === "dry_run", `status=${r.status}`);
  assert(!fs.existsSync(path.join(home, "rules", "always", "dry.md")), "no file on dry_run");
});

await check("archive: status -> archived in place (rule stops injecting, file kept)", async () => {
  const home = freshHome();
  const opts = { abrainHome: home, settings: SETTINGS };
  await writeAbrainRule({ ...baseDraft, title: "Veto me", body: "this rule will be vetoed by user", injectMode: "always", scope: "global" }, opts);
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
  await writeAbrainRule({ ...baseDraft, title: "Gone soon", body: "this rule will be hard-deleted ok", injectMode: "listed", scope: "global", kind: "pattern" }, opts);
  const found = findRuleFile(home, "global", undefined, "gone-soon");
  assert(found && fs.existsSync(found.path), "exists before delete");
  const r = await deleteAbrainRule("gone-soon", "global", undefined, opts);
  assert(r.status === "deleted", `delete status: ${JSON.stringify(r)}`);
  assert(!fs.existsSync(found.path), "file gone after delete");
});

// ── Tier-2 rules legacy write gate: observe/block/off + context boundary ────
await check("tier2 gate observe: context create writes rule and records allow audit", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Gate Observe", body: "tier two observe still writes the legacy rule", injectMode: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: gateSettings("observe"), tier2RulesLegacyWriteContext: tier2GateContext("create", { slug: "Gate Observe", injectMode: "listed" }) });
  assert(r.status === "created", `observe should not block create: ${JSON.stringify(r)}`);
  assert(!r.tier2RulesLegacyWriteGate, "observe mode does not alter result metadata");
  assert(fs.existsSync(path.join(home, "rules", "listed", "gate-observe.md")), "observe create wrote rule file");
  const event = latestGateEvent(home);
  assert(event && event.gate_mode === "observe" && event.gate_decision === "allow", `observe audit: ${JSON.stringify(event)}`);
  assert(event.slug === "gate-observe" && event.context_slug === "Gate Observe", `canonical slug preserved: ${JSON.stringify(event)}`);
  assert(event.caller === "curator_decision_writer" && event.rule_operation === "create" && event.target_scope === "global", `audit context: ${JSON.stringify(event)}`);
  assert(event.inject_mode === "listed" && event.dry_run === false, `audit mode: ${JSON.stringify(event)}`);
});

await check("tier2 gate block: context create returns skipped and writes no rule", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Gate Block", body: "tier two block must not write legacy rule", injectMode: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: gateSettings("block"), tier2RulesLegacyWriteContext: tier2GateContext("create", { slug: "Gate Block", injectMode: "listed" }) });
  assert(r.status === "skipped" && r.reason === "tier2_rules_legacy_write_blocked", `block create: ${JSON.stringify(r)}`);
  assert(r.tier2RulesLegacyWriteGate?.mode === "block" && r.tier2RulesLegacyWriteGate.blocked === true, `block metadata: ${JSON.stringify(r)}`);
  assert(!fs.existsSync(path.join(home, "rules", "listed", "gate-block.md")), "block create did not write rule file");
  const event = latestGateEvent(home);
  assert(event && event.gate_mode === "block" && event.gate_decision === "block", `block audit: ${JSON.stringify(event)}`);
  assert(event.slug === "gate-block" && event.context_slug === "Gate Block", `canonical slug preserved: ${JSON.stringify(event)}`);
});

await check("tier2 gate block: direct writer without context is not blocked", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Direct Writer", body: "direct rules writer remains available without tier two context", injectMode: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: gateSettings("block") });
  assert(r.status === "created", `direct writer should create: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "listed", "direct-writer.md")), "direct writer created rule file");
  assert(!latestGateEvent(home), `direct writer should not emit gate audit: ${JSON.stringify(auditEvents(home))}`);
});

await check("tier2 gate block: archive/delete return skipped without mutating files", async () => {
  const archiveHome = freshHome();
  await writeAbrainRule({ ...baseDraft, title: "Archive Block", body: "archive target stays active under tier two block", injectMode: "listed", scope: "global", kind: "pattern" }, { abrainHome: archiveHome, settings: SETTINGS });
  const archivePath = path.join(archiveHome, "rules", "listed", "archive-block.md");
  const beforeArchive = fs.readFileSync(archivePath, "utf-8");
  const archived = await archiveAbrainRule("archive-block", "global", undefined, {
    abrainHome: archiveHome,
    settings: gateSettings("block"),
    reason: "blocked by smoke",
    tier2RulesLegacyWriteContext: tier2GateContext("archive", { slug: "archive-block" }),
  });
  assert(archived.status === "skipped" && archived.reason === "tier2_rules_legacy_write_blocked", `archive block: ${JSON.stringify(archived)}`);
  assert(fs.readFileSync(archivePath, "utf-8") === beforeArchive, "archive block left file byte-identical");
  const archiveEvent = latestGateEvent(archiveHome);
  assert(archiveEvent?.rule_operation === "archive" && archiveEvent.gate_decision === "block", `archive audit: ${JSON.stringify(archiveEvent)}`);

  const deleteHome = freshHome();
  await writeAbrainRule({ ...baseDraft, title: "Delete Block", body: "delete target remains present under tier two block", injectMode: "listed", scope: "global", kind: "pattern" }, { abrainHome: deleteHome, settings: SETTINGS });
  const deletePath = path.join(deleteHome, "rules", "listed", "delete-block.md");
  const beforeDelete = fs.readFileSync(deletePath, "utf-8");
  const deleted = await deleteAbrainRule("delete-block", "global", undefined, {
    abrainHome: deleteHome,
    settings: gateSettings("block"),
    tier2RulesLegacyWriteContext: tier2GateContext("delete", { slug: "delete-block" }),
  });
  assert(deleted.status === "skipped" && deleted.reason === "tier2_rules_legacy_write_blocked", `delete block: ${JSON.stringify(deleted)}`);
  assert(fs.existsSync(deletePath), "delete block kept file present");
  assert(fs.readFileSync(deletePath, "utf-8") === beforeDelete, "delete block left file byte-identical");
  const deleteEvent = latestGateEvent(deleteHome);
  assert(deleteEvent?.rule_operation === "delete" && deleteEvent.gate_decision === "block", `delete audit: ${JSON.stringify(deleteEvent)}`);
});

await check("tier2 gate off: context create writes without gate audit", async () => {
  const home = freshHome();
  const r = await writeAbrainRule(
    { ...baseDraft, title: "Gate Off", body: "tier two off disables the legacy write gate", injectMode: "listed", scope: "global", kind: "pattern" },
    { abrainHome: home, settings: gateSettings("off"), tier2RulesLegacyWriteContext: tier2GateContext("create", { slug: "Gate Off", injectMode: "listed" }) });
  assert(r.status === "created", `off should create: ${JSON.stringify(r)}`);
  assert(fs.existsSync(path.join(home, "rules", "listed", "gate-off.md")), "off wrote rule file");
  assert(!latestGateEvent(home), `off should not emit gate audit: ${JSON.stringify(auditEvents(home))}`);
});

// ── end-to-end: parseDecision -> dispatch -> rule writer (W0.2 + W2) ─────────
await check("e2e: parseDecision rules-create -> executeCuratorDecisionToBrain -> file", async () => {
  const home = freshHome();
  const decision = parseDecision(JSON.stringify({ op: "create", zone: "rules", inject_mode: "always", rule_scope: "global", rationale: "user said 永远 use edit" }), new Map());
  assert(decision.op === "create" && decision.zone === "rules" && decision.injectMode === "always" && decision.ruleScope === "global", `decision: ${JSON.stringify(decision)}`);
  const results = await executeCuratorDecisionToBrain({
    decision,
    draft: { title: "Edit only", kind: "maxim", status: "active", confidence: 9, compiledTruth: "修改文件必须用 edit/write，禁止 sed。" },
    projectRoot: home, abrainHome: home, projectId: "pi-global", settings: SETTINGS,
  });
  assert(results[0].status === "created" && results[0].lane === "rules", `e2e create: ${JSON.stringify(results[0])}`);
  assert(fs.existsSync(path.join(home, "rules", "always", "edit-only.md")), "rule file written via dispatch");
});

await check("e2e: tier2 gate block via curator returns skipped, not rejected", async () => {
  const home = freshHome();
  const decision = parseDecision(JSON.stringify({ op: "create", zone: "rules", inject_mode: "listed", rule_scope: "global", rationale: "smoke block" }), new Map());
  const results = await executeCuratorDecisionToBrain({
    decision,
    draft: { title: "Curator Block", kind: "pattern", status: "active", confidence: 8, compiledTruth: "curator block must return skipped and avoid legacy write" },
    projectRoot: home, abrainHome: home, projectId: "pi-global", settings: gateSettings("block"),
  });
  assert(results.length === 1, `one result: ${JSON.stringify(results)}`);
  assert(results[0].status === "skipped" && results[0].reason === "tier2_rules_legacy_write_blocked", `curator block should skip: ${JSON.stringify(results[0])}`);
  assert(results[0].status !== "rejected", `curator block must not reject: ${JSON.stringify(results[0])}`);
  assert(results[0].tier2RulesLegacyWriteGate?.blocked === true, `gate metadata carried: ${JSON.stringify(results[0])}`);
  assert(!fs.existsSync(path.join(home, "rules", "listed", "curator-block.md")), "curator block wrote no rule file");
  const event = latestGateEvent(home);
  assert(event?.slug === "curator-block" && event.context_slug === "Curator Block", `curator audit slug: ${JSON.stringify(event)}`);
});

await check("e2e: project rules-create routes to projects/<id>/rules + archive routes by slug", async () => {
  const home = freshHome();
  // §12.3 dual-read regression: a legacy `tier` key (pre-rename LLM output or
  // persisted multiview replay decision) must still parse into injectMode.
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

// ── Publication boundary: canonical durable-first vs legacy rollback ────────
function runGitPublicationFixture(mode) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-rule-fs-${mode}-`));
  const settingsPath = path.join(fixtureDir, "pi-astack-settings.json");
  const reportPath = path.join(fixtureDir, "report.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify({ canonicalGitRuntime: { enabled: mode === "canonical", mode: "local_convergence_v2" } })}\n`);
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        PI_ASTACK_SETTINGS_PATH: settingsPath,
        PI_ASTACK_RULE_WRITER_FS_GIT_PUBLICATION_FIXTURE: mode,
        PI_ASTACK_RULE_WRITER_FS_GIT_PUBLICATION_REPORT: reportPath,
      },
      encoding: "utf-8",
    });
    assert(child.status === 0, `${mode} fixture failed: ${child.stderr || child.stdout}`);
    return JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

await check("canonical durable-first: blocked publication preserves archive/delete mutations", async () => {
  const report = runGitPublicationFixture("canonical");
  for (const [operation, outcome] of Object.entries({ archive: report.archive, delete: report.delete })) {
    const publication = outcome.result.publication;
    assert(outcome.result.status === (operation === "archive" ? "archived" : "deleted"), `${operation} must retain its top-level local mutation: ${JSON.stringify(outcome.result)}`);
    // publication.status, rather than the top-level operation status, is the
    // cross-Git durability judgment. Do not add a redundant result flag.
    assert(publication?.canonical === true && publication.status === "durable_pending" && publication.localCommit === "not_published" && publication.drainStatus === "blocked", `${operation} canonical publication contract: ${JSON.stringify(publication)}`);
    if (operation === "archive") {
      assert(outcome.existsAfter && /status:\s*"?archived"?/.test(outcome.bytesAfter), "canonical archive must stay persisted without rollback");
    } else {
      assert(!outcome.existsAfter && outcome.bytesAfter === null, "canonical delete must stay removed without rollback");
    }
  }
});

await check("legacy rollback: failed git commit rejects archive/delete and restores bytes", async () => {
  const report = runGitPublicationFixture("legacy");
  for (const [operation, outcome] of Object.entries({ archive: report.archive, delete: report.delete })) {
    const publication = outcome.result.publication;
    assert(outcome.result.status === "rejected" && outcome.result.reason === "git_commit_failed", `${operation} legacy failure must reject: ${JSON.stringify(outcome.result)}`);
    assert(publication?.canonical === false && publication.status === "terminal_before_publish" && publication.localCommit === "not_published", `${operation} legacy publication contract: ${JSON.stringify(publication)}`);
    assert(outcome.existsAfter && outcome.bytesAfter === outcome.before, `${operation} legacy rollback must restore byte-identical file`);
  }
});

// ── #1 escalate routing predicate (T0 consensus) ───────────────────────
await check("#1 isTier1Directive: user-expressed durable CREATE escalates; is_directive exempts the conf gate", async () => {
  // ADR 0028 v1.1 R2' + O5-converged predicate (PR-2 2026-06-10): the
  // structural gate is DETERMINISTIC AX-PROVENANCE (turn.role), and
  // is_directive (recall-biased, prompt v2) exempts the conf≥8 fallback.
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 9, user_quote: "all git.alfadb.cn repos must use glab", provenance: "user-expressed" }) === true, "user-expressed create rule -> escalate");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 6, user_quote: "x", provenance: "user-expressed" }) === false, "low-conf NON-directive (陈述式) -> conf fallback holds -> stage, not escalate");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 6, is_directive: true, user_quote: "x", provenance: "user-expressed" }) === true, "祈使 directive exempts the confidence gate (R2' recall bias)");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 1, is_directive: true, user_quote: "x", provenance: "user-expressed" }) === true, "even conf=1 directive commits (low-confidence tell marker, not a gate)");
  // PR-A3 (F6, 2026-06-12 计划附录A): targeted is_directive 不再被踢出 Tier-1 ——
  // 指令本体确定性提交为规则，被指向的知识条目由 curator 带 context 衰变。
  // （原断言把“复述已有规则”与 targeted directive 混为一谈：复述按 prompt v2
  // abstain 列表应是 is_directive=false，由下一条断言覆盖。）
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 9, is_directive: true, user_quote: "x", provenance: "user-expressed", target_entry_slug: "existing" }) === true, "targeted 祈使 directive -> Tier-1 照常提交 (PR-A3)");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 9, user_quote: "x", provenance: "user-expressed", target_entry_slug: "existing" }) === false, "targeted 高置信非 directive (记忆管理纠错/复述) -> conf fallback 保留 !target -> 转发 curator");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 9, is_directive: true, user_quote: "x", provenance: "content-in-transcript" }) === false, "引述他人祈使 (README/tool) -> structural provenance gate wins over is_directive");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "durable", confidence: 9, user_quote: "x", provenance: "assistant-observed" }) === false, "assistant-observed -> not user-expressed -> not escalate");
  assert(shouldEscalateToCurator({ signal_found: true, typing: "task-local", confidence: 9, is_directive: true, user_quote: "x", provenance: "user-expressed" }) === false, "task-local directive -> not durable -> not escalate");
  assert(shouldEscalateToCurator({ signal_found: false }) === false && shouldEscalateToCurator(null) === false, "no signal -> not escalate");
  // Alias contract: shouldEscalateToCurator delegates to isTier1Directive
  // (one canonical predicate definition).
  const probe = { signal_found: true, typing: "durable", confidence: 6, is_directive: true, user_quote: "x", provenance: "user-expressed" };
  assert(isTier1Directive(probe) === shouldEscalateToCurator(probe), "isTier1Directive is canonical; shouldEscalateToCurator is its alias");
});

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
console.log(`\nall ok — writeAbrainRule fs orchestration holds (${total} assertions).`);
