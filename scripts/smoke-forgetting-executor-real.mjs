#!/usr/bin/env node
// ADR 0031 Phase 3 real demote 路径 smoke(含 opus/gpt/deepseek M4/M5 review Round-2 修复):
//   - no archiveEntry → dry_run, archiveEntry 绝不被调(零 mutation)
//   - archiveEntry injected → 逐条 archiveEntry(CAS)+ markProposalsExecuted + setEntryHysteresis + ledger
//   - 幂等:executed proposal 不再进 plan
//   - CAS reject(rejected:true)→ ABANDON(标 executed 停重试,不再留 pending → 防复活后重放)
//   - 断路器:corpus_floor(active-planned<50)+ fail-closed(active 未知)+ daily_cap(24h≥20)
//   - fail-safe:resurrection insufficient_data → backoff → 不 demote
//   - per-project:resurrectionRateReport(pr) 只计本项目复活(防跨项目污染)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forgetting-real-")); // sandbox: 不碰生产 ~/.abrain
process.env.ABRAIN_ROOT = tmp;
const jiti = createJiti(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS:", m); } else { fail++; console.error("FAIL:", m); } };

const pr = path.join(tmp, "proj");
const foreign = path.join(tmp, "other-proj");
fs.mkdirSync(pr, { recursive: true });

const fx = await jiti.import("../extensions/sediment/forgetting-executor.ts");
const elp = await jiti.import("../extensions/sediment/entry-lifecycle-proposals.ts");
const et = await jiti.import("../extensions/sediment/entry-telemetry.ts");
const ar = await jiti.import("../extensions/sediment/archive-reactivation.ts");
const rm = await jiti.import("../extensions/sediment/resurrection-rate-monitor.ts");

const NOW = Date.now();
const DAY = 86_400_000;
fs.mkdirSync(path.dirname(fx.forgettingDemoteLedgerPath()), { recursive: true });
const reactLedger = ar.archiveReactivationLedgerPath();
const demoteLedger = fx.forgettingDemoteLedgerPath();

// 暖 resurrection(本项目 stable rate 0.25;外项目全 reactivate 高率 —— 用于 per-project 隔离测试)
const rrow = (root, decision, daysAgo, seq) => JSON.stringify({ operation: "archive_reactivation_decision", project_root: path.resolve(root), slug: `r${seq}`, decision, ts: new Date(NOW - daysAgo * DAY).toISOString() });
const warmRows = [
  rrow(pr, "keep_archived", 2, 1), rrow(pr, "keep_archived", 4, 2), rrow(pr, "keep_archived", 6, 3), rrow(pr, "reactivate", 8, 4),
  rrow(pr, "keep_archived", 35, 5), rrow(pr, "keep_archived", 37, 6), rrow(pr, "keep_archived", 39, 7), rrow(pr, "reactivate", 41, 8),
  // 外项目: 全 reactivate(若漏过滤会污染本项目 → 高 rate → backoff)
  rrow(foreign, "reactivate", 1, 9), rrow(foreign, "reactivate", 3, 10), rrow(foreign, "reactivate", 5, 11),
  rrow(foreign, "reactivate", 35, 12), rrow(foreign, "reactivate", 37, 13), rrow(foreign, "reactivate", 39, 14),
];
const seedWarm = () => fs.writeFileSync(reactLedger, warmRows.join("\n") + "\n", "utf-8");
seedWarm();

// ---- per-project 隔离(deepseek P0)----
{
  const mine = rm.resurrectionRateReport(30, new Date(NOW), pr);
  const global = rm.resurrectionRateReport(30, new Date(NOW));
  ok(mine.recent.resurrection_rate === 0.25, `per-project: 本项目 rate=0.25(got ${mine.recent.resurrection_rate})`);
  ok(global.recent.resurrection_rate > 0.25, "全局(无过滤)rate 被外项目抬高 → 证明 per-project 过滤生效");
}

const settings = (enabled = true) => ({ forgetting: { enabled, instrumentation: false } });
const prop = (slug, kind = "fact", reason = "affirm_superseded") => ({ slug, kind, lifecycle_proposal: { op: "archive", reason, independent_evidence: `${slug} ${reason}`, falsifier: "if not" } });
const mkArchive = (result) => { const calls = []; const targets = []; return { calls, targets, fn: async (t) => { calls.push(t.slug); targets.push(t); return typeof result === "function" ? result(t) : result; } }; };
const statusOf = (slug) => { const r = elp.readLifecycleProposals(pr).find((x) => x.slug === slug); return r ? r.status : "absent"; };
const readJsonl = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const appendRawProposal = (row) => fs.appendFileSync(elp.entryLifecycleProposalsPath(), JSON.stringify({ schema_version: 1, ts: new Date(NOW).toISOString(), project_root: path.resolve(pr), op: "archive", status: "pending", disposition: "execution_ready", expected_status: "active", independent_evidence: "fixture", falsifier: "fixture", ...row }) + "\n", "utf-8");
const writeDurableKind = (slug, kind, status = "active") => fs.writeFileSync(path.join(pr, `${slug}.md`), `---\nid: project:test:${slug}\nkind: ${kind}\nstatus: ${status}\n---\n# ${slug}\n`, "utf-8");
const writeDistributionEntry = (slug, kind, status) => {
  const dir = path.join(tmp, "projects", "kind-dist");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), `---\nid: project:dist:${slug}\nkind: ${kind}\nstatus: ${status}\n---\n# ${slug}\n`, "utf-8");
};

elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-a"), prop("decay-b")] });

// ---- 1) no archiveEntry → dry_run, 零 mutation ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.ok && r.dry_run === true && arc.calls.length === 0, "no archiveEntry → dry_run + archiveEntry 零调用");
  ok(elp.readLifecycleProposals(pr).every((x) => x.status === "pending"), "dry-run → proposals 仍 pending");
  const audit = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  ok(audit?.schema_version === 1 && audit.row_kind === "dry_run_plan" && audit.idempotency_key, "dry-run audit carries schema_version/row_kind/idempotency_key");
  ok(Array.isArray(audit?.would_demote_proposal_ids) && audit.would_demote_proposal_ids.length === 2, "dry-run audit carries would_demote_proposal_ids");
}

// ---- 2) archiveEntry injected → 真实编排 ----
{
  const arc = mkArchive({ ok: true, status: "archived", rejected: false });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.dry_run === false && arc.calls.length === 2 && r.demoted.length === 2, `on → demote 2 (calls=${arc.calls.length} demoted=${r.demoted?.length})`);
  ok(arc.targets.every((t) => t.expected_status === "active"), "legacy active proposals pass expected_status=active");
  ok(arc.targets.every((t) => t.proposal_id && t.evidence_source === "aggregator_promoted_advisory" && t.evidence_type === "superseded_by"), "archive targets carry proposal/evidence join fields");
  ok(statusOf("decay-a") === "executed" && statusOf("decay-b") === "executed", "on → proposals executed");
  ok(et.getEntryTelemetry(pr, "decay-a")?.proposal_cooldown_until, "on → cooldown 写入");
  const ledgerRows = readJsonl(demoteLedger);
  const demoteRows = ledgerRows.filter((row) => row.op === "demote");
  ok(demoteRows.length === 2, "on → demote-ledger 2 demote 行");
  ok(demoteRows.every((row) => row.proposal_id && row.evidence_source === "aggregator_promoted_advisory" && row.evidence_type === "superseded_by" && row.idempotency_key), "demote-ledger rows carry proposal/evidence/idempotency join fields");
  ok(ledgerRows.some((row) => row.row_kind === "action_summary" && row.counts?.demoted === 2 && row.demoted_by_kind?.fact === 2), "nonzero demote batch appends action_summary");
  const audit = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  ok(audit?.schema_version === 1 && audit.row_kind === "real_apply" && audit.idempotency_key, "real audit carries schema_version/row_kind/idempotency_key");
  ok(Array.isArray(audit?.planned_proposal_ids) && audit.planned_proposal_ids.length === 2 && Array.isArray(audit?.demoted_proposal_ids) && audit.demoted_proposal_ids.length === 2, "real audit carries planned/demoted proposal ids");
}

// ---- 3) 幂等 ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "幂等:executed 不再 demote");
}

// ---- 4) CAS reject → ABANDON(标 executed, 不留 pending)----
elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-c")] });
{
  const arc = mkArchive({ ok: false, status: "active", error: "status_precondition_failed", rejected: true });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(arc.calls.includes("decay-c") && r.abandoned?.includes("decay-c"), "CAS reject → abandoned");
  ok((r.demoted?.length ?? 0) === 0, "CAS reject → 不计 demoted");
  ok(statusOf("decay-c") === "executed", "CAS reject → proposal 标 executed(停重试, 防复活后重放, 不再 pending)");
}

// ---- 5) frontmatter E1/E2: E1 expected_status=superseded executes; E2 review_required stays pending ----
elp.appendSupersededFrontmatterProposals({
  projectRoot: pr,
  entries: [
    { slug: "sup-a", kind: "decision", status: "superseded", frontmatter: { status: "superseded", superseded_by: ["sup-new"] }, relations: [{ type: "superseded_by", to: "sup-new" }] },
    { slug: "sup-b", kind: "decision", status: "superseded", frontmatter: { status: "superseded" }, relations: [] },
  ],
});
{
  const arc = mkArchive({ ok: true, status: "archived", rejected: false });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(arc.calls.length === 1 && arc.calls[0] === "sup-a" && r.demoted?.includes("sup-a"), "E1 frontmatter proposal executes exactly once");
  ok(arc.targets[0]?.expected_status === "superseded", "E1 passes expected_status=superseded to archiveEntry");
  ok(arc.targets[0]?.proposal_id && arc.targets[0]?.evidence_source === "frontmatter_superseded" && arc.targets[0]?.evidence_type === "superseded_by", "E1 archive target carries frontmatter proposal/evidence join fields");
  ok(statusOf("sup-a") === "executed", "E1 proposal marked executed");
  ok(statusOf("sup-b") === "pending", "E2 review_required proposal remains pending and unexecuted");
}

// ---- 6) executor gates: lane_required + kind_mismatch + enabled=false strict-off ----
appendRawProposal({ slug: "lane-a", kind: "anti-pattern", reason: "affirm_stale", evidence_source: "aggregator_promoted_advisory", evidence_type: "version_stale", evidence_key: "lane-a" });
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  const audit = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "anti-pattern + version_stale → no mutation");
  ok(audit?.row_kind === "executor_gate_skip" && audit.skip_reasons?.includes("lane_required"), "anti-pattern + version_stale → lane_required audit");
  ok(statusOf("lane-a") === "pending", "lane_required proposal remains pending");
}
writeDurableKind("unknown-a", "emerging-kind");
appendRawProposal({ slug: "unknown-a", kind: "emerging-kind", reason: "affirm_superseded", evidence_source: "aggregator_promoted_advisory", evidence_type: "superseded_by", evidence_key: "unknown-a" });
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  const audit = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  const unknownSkip = audit?.skipped?.find((s) => s.slug === "unknown-a");
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "unknown kind + valid evidence(non-E1) → no mutation");
  ok(unknownSkip?.skip_reason === "lane_required" && unknownSkip?.durable_kind === "emerging-kind", "unknown kind + valid evidence(non-E1) → lane_required audit with durable_kind");
  ok(statusOf("unknown-a") === "pending", "unknown kind lane_required proposal remains pending");
}
writeDurableKind("mismatch-a", "smell");
appendRawProposal({ slug: "mismatch-a", kind: "fact", reason: "affirm_superseded", evidence_source: "aggregator_promoted_advisory", evidence_type: "superseded_by", evidence_key: "mismatch-a" });
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  const audit = readJsonl(fx.forgettingDryRunAuditPath()).at(-1);
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "kind_mismatch → no mutation");
  ok(audit?.row_kind === "executor_gate_skip" && audit.skip_reasons?.includes("kind_mismatch"), "kind_mismatch audit written");
  ok(statusOf("mismatch-a") === "pending", "kind_mismatch proposal remains pending");
}
{
  const auditBefore = readJsonl(fx.forgettingDryRunAuditPath()).length;
  const ledgerBefore = readJsonl(demoteLedger).length;
  elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("disabled-a")] });
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(false), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.enabled === false && r.reason === "forgetting_disabled" && arc.calls.length === 0, "enabled=false → executor strict-off");
  ok(readJsonl(fx.forgettingDryRunAuditPath()).length === auditBefore && readJsonl(demoteLedger).length === ledgerBefore, "enabled=false → zero forgetting audit/ledger writes");
  ok(statusOf("disabled-a") === "pending", "enabled=false → zero proposal mutation");
}

// ---- 7) 断路器 corpus_floor: plannedCount + fail-closed ----
fs.rmSync(demoteLedger, { force: true });
elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-e"), prop("decay-f")] }); // 2 pending
{
  // active=51, planned=2 → 51-2=49 < 50 → trip(plannedCount 计入)
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 51 }, new Date(NOW));
  ok(r.dry_run === true && r.circuit_breaker?.reason === "corpus_floor" && arc.calls.length === 0, "corpus_floor: active51-planned2<50 → trip(plannedCount 计入)");
}
{
  // activeCorpusSize 未传(undefined)→ fail-closed → trip
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn }, new Date(NOW));
  ok(r.dry_run === true && r.circuit_breaker?.reason === "corpus_floor" && arc.calls.length === 0, "corpus_floor fail-closed: active 未知 → trip(零 mutation)");
}

// ---- 7) 断路器 daily_cap ----
{
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(JSON.stringify({ ts_ms: NOW - i * 1000, slug: `past${i}`, op: "demote" }));
  fs.writeFileSync(demoteLedger, rows.join("\n") + "\n", "utf-8");
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.circuit_breaker?.reason === "daily_cap" && arc.calls.length === 0, "daily_cap(20 in 24h)→ trip, 零 mutation");
}

// ---- 8) fail-safe insufficient_data ----
fs.rmSync(demoteLedger, { force: true });
fs.writeFileSync(reactLedger, "", "utf-8");
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok((r.plan?.resurrection_backoff ?? false) === true && arc.calls.length === 0, "insufficient_data → backoff, 不 demote");
}

// ---- 9) kind_distribution_alert 24h 去重 ----
for (let i = 0; i < 10; i++) writeDistributionEntry(`dist-fact-${i}`, "fact", "active");
writeDistributionEntry("dist-smell-active", "smell", "active");
for (let i = 0; i < 10; i++) writeDistributionEntry(`dist-smell-archived-${i}`, "smell", "archived");
{
  const countAlerts = () => readJsonl(fx.forgettingDryRunAuditPath()).filter((row) => row.row_kind === "kind_distribution_alert").length;
  const before = countAlerts();
  const arc1 = mkArchive({ ok: true, status: "archived" });
  await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc1.fn, activeCorpusSize: 1000 }, new Date(NOW));
  const afterFirst = countAlerts();
  const alert = readJsonl(fx.forgettingDryRunAuditPath()).filter((row) => row.row_kind === "kind_distribution_alert").at(-1);
  const arc2 = mkArchive({ ok: true, status: "archived" });
  await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc2.fn, activeCorpusSize: 1000 }, new Date(NOW + 1000));
  const afterSecond = countAlerts();
  ok(afterFirst === before + 1, "kind_distribution_alert first persistent alert writes once");
  ok(afterSecond === afterFirst, "kind_distribution_alert duplicate within 24h is skipped");
  ok(typeof alert?.ts_ms === "number" && alert.idempotency_key, "kind_distribution_alert carries ts_ms/idempotency_key");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — forgetting-executor real path (Round-2): ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
