#!/usr/bin/env node
// ADR 0031 Phase 3 real demote 路径 smoke(含 opus/gpt/deepseek M4/M5 review Round-2 修复):
//   - autoDemote off → dry_run, archiveEntry 绝不被调(零 mutation)
//   - autoDemote on  → 逐条 archiveEntry(CAS)+ markProposalsExecuted + setEntryHysteresis + ledger
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

const settings = (autoDemote) => ({ forgetting: { demoteShadow: true, autoDemote, demoteMaxBatch: 5, resurrectionBackoffRate: 0.5, instrumentation: false, decayShadow: false } });
const prop = (slug) => ({ slug, kind: "decision", lifecycle_proposal: { op: "archive", reason: "affirm_superseded", independent_evidence: `${slug} superseded`, falsifier: "if not" } });
const mkArchive = (result) => { const calls = []; const targets = []; return { calls, targets, fn: async (t) => { calls.push(t.slug); targets.push(t); return typeof result === "function" ? result(t) : result; } }; };
const statusOf = (slug) => { const r = elp.readLifecycleProposals(pr).find((x) => x.slug === slug); return r ? r.status : "absent"; };

elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-a"), prop("decay-b")] });

// ---- 1) autoDemote OFF → dry_run, 零 mutation ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(false), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.ok && r.dry_run === true && arc.calls.length === 0, "autoDemote off → dry_run + archiveEntry 零调用");
  ok(elp.readLifecycleProposals(pr).every((x) => x.status === "pending"), "off → proposals 仍 pending");
}

// ---- 2) autoDemote ON → 真实编排 ----
{
  const arc = mkArchive({ ok: true, status: "archived", rejected: false });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.dry_run === false && arc.calls.length === 2 && r.demoted.length === 2, `on → demote 2 (calls=${arc.calls.length} demoted=${r.demoted?.length})`);
  ok(arc.targets.every((t) => t.expected_status === "active"), "legacy active proposals pass expected_status=active");
  ok(statusOf("decay-a") === "executed" && statusOf("decay-b") === "executed", "on → proposals executed");
  ok(et.getEntryTelemetry(pr, "decay-a")?.proposal_cooldown_until, "on → cooldown 写入");
  ok(fs.readFileSync(demoteLedger, "utf-8").trim().split("\n").length === 2, "on → demote-ledger 2 行");
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
  ok(statusOf("sup-a") === "executed", "E1 proposal marked executed");
  ok(statusOf("sup-b") === "pending", "E2 review_required proposal remains pending and unexecuted");
}

// ---- 6) 断路器 corpus_floor: plannedCount + fail-closed ----
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — forgetting-executor real path (Round-2): ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
