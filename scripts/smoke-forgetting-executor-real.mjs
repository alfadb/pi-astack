#!/usr/bin/env node
// ADR 0031 Phase 3 real demote 路径 smoke(opus M4/M5 review 闭环验证):
//   - autoDemote off → dry_run, archiveEntry 绝不被调(零 mutation)
//   - autoDemote on  → 逐条 archiveEntry(CAS)+ markProposalsExecuted + setEntryHysteresis + ledger
//   - 幂等:executed proposal 不再进 plan
//   - CAS reject(archiveEntry ok:false)→ failed, 条目留 pending
//   - 断路器:corpus_floor(active≤50)+ daily_cap(24h≥20)→ tripped, 零 mutation
//   - fail-safe:resurrection insufficient_data → backoff → 不 demote(冷启动安全)
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
fs.mkdirSync(pr, { recursive: true });

const fx = await jiti.import("../extensions/sediment/forgetting-executor.ts");
const elp = await jiti.import("../extensions/sediment/entry-lifecycle-proposals.ts");
const et = await jiti.import("../extensions/sediment/entry-telemetry.ts");
const ar = await jiti.import("../extensions/sediment/archive-reactivation.ts");

const NOW = Date.now();
const DAY = 86_400_000;
const sedDir = path.dirname(fx.forgettingDemoteLedgerPath());
fs.mkdirSync(sedDir, { recursive: true });
const reactLedger = ar.archiveReactivationLedgerPath();
const demoteLedger = fx.forgettingDemoteLedgerPath();

// 暖 resurrection(stable, rate 0.25 < 0.5, 两窗各 ≥3 reviewed → 非 insufficient_data)
const rrow = (decision, daysAgo, seq) => JSON.stringify({ operation: "archive_reactivation_decision", slug: `r${seq}`, decision, ts: new Date(NOW - daysAgo * DAY).toISOString() });
const warmRows = [
  rrow("keep_archived", 2, 1), rrow("keep_archived", 4, 2), rrow("keep_archived", 6, 3), rrow("reactivate", 8, 4),
  rrow("keep_archived", 35, 5), rrow("keep_archived", 37, 6), rrow("keep_archived", 39, 7), rrow("reactivate", 41, 8),
];
const seedWarm = () => fs.writeFileSync(reactLedger, warmRows.join("\n") + "\n", "utf-8");
seedWarm();

const settings = (autoDemote) => ({ forgetting: { demoteShadow: true, autoDemote, demoteMaxBatch: 5, resurrectionBackoffRate: 0.5, instrumentation: false, decayShadow: false } });
const prop = (slug) => ({ slug, kind: "decision", lifecycle_proposal: { op: "archive", reason: "affirm_superseded", independent_evidence: `${slug} superseded`, falsifier: "if not" } });

// 跟踪 archiveEntry 调用
const mkArchive = (result) => { const calls = []; return { calls, fn: async (t) => { calls.push(t.slug); return typeof result === "function" ? result(t) : result; } }; };

// ---- seed 两条 pending archive proposal ----
elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-a"), prop("decay-b")] });

// ---- 1) autoDemote OFF → dry_run, 零 mutation ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(false), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.ok && r.dry_run === true, "autoDemote off → dry_run true");
  ok(arc.calls.length === 0, "autoDemote off → archiveEntry 绝不被调(零 mutation)");
  const rows = elp.readLifecycleProposals(pr);
  ok(rows.length === 2 && rows.every((x) => x.status === "pending"), "off → proposals 仍 pending");
}

// ---- 2) autoDemote ON → 真实 demote 编排 ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.ok && r.dry_run === false, "autoDemote on → dry_run false");
  ok(arc.calls.length === 2 && r.demoted.length === 2, `on → archiveEntry 调 2 次 + demoted 2 (calls=${arc.calls.length} demoted=${r.demoted?.length})`);
  const rows = elp.readLifecycleProposals(pr);
  ok(rows.every((x) => x.status === "executed"), "on → proposals 标 executed");
  const tA = et.getEntryTelemetry(pr, "decay-a");
  ok(tA && tA.proposal_cooldown_until, "on → setEntryHysteresis 写了 cooldown");
  ok(fs.existsSync(demoteLedger) && fs.readFileSync(demoteLedger, "utf-8").trim().split("\n").length === 2, "on → demote-ledger 2 行");
}

// ---- 3) 幂等:executed 不再进 plan ----
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "幂等:executed proposal 不再 demote");
}

// ---- 4) CAS reject → failed, 留 pending ----
elp.appendLifecycleProposals({ projectRoot: pr, promoted: [prop("decay-c")] });
{
  const arc = mkArchive({ ok: false, status: "active", error: "status_precondition_failed" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(arc.calls.includes("decay-c"), "CAS test: archiveEntry 被调");
  ok((r.demoted?.length ?? 0) === 0 && r.failed?.some((f) => f.slug === "decay-c"), "CAS reject → failed, 不计 demoted");
  const c = elp.readLifecycleProposals(pr).find((x) => x.slug === "decay-c");
  ok(c && c.status === "pending", "CAS reject → 条目留 pending(下轮重试)");
}

// ---- 5) 断路器 corpus_floor(active≤50)→ tripped ----
fs.rmSync(demoteLedger, { force: true }); // 清 ledger 避免 daily_cap 干扰
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 10 }, new Date(NOW));
  ok(r.dry_run === true && r.circuit_breaker?.tripped && r.circuit_breaker.reason === "corpus_floor", "corpus_floor(active=10)→ 断路器 tripped");
  ok(arc.calls.length === 0, "corpus_floor → archiveEntry 不被调(零 mutation)");
  const c = elp.readLifecycleProposals(pr).find((x) => x.slug === "decay-c");
  ok(c && c.status === "pending", "corpus_floor → decay-c 留 pending");
}

// ---- 6) 断路器 daily_cap(24h≥20)→ tripped ----
{
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(JSON.stringify({ ts_ms: NOW - i * 1000, slug: `past${i}`, op: "demote" }));
  fs.writeFileSync(demoteLedger, rows.join("\n") + "\n", "utf-8");
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok(r.dry_run === true && r.circuit_breaker?.tripped && r.circuit_breaker.reason === "daily_cap", `daily_cap(20 in 24h)→ tripped (reason=${r.circuit_breaker?.reason})`);
  ok(arc.calls.length === 0, "daily_cap → archiveEntry 不被调");
}

// ---- 7) fail-safe:resurrection insufficient_data → backoff, 不 demote ----
fs.rmSync(demoteLedger, { force: true });
fs.writeFileSync(reactLedger, "", "utf-8"); // 清空 → insufficient_data
{
  const arc = mkArchive({ ok: true, status: "archived" });
  const r = await fx.runForgettingExecutor(pr, settings(true), { archiveEntry: arc.fn, activeCorpusSize: 1000 }, new Date(NOW));
  ok((r.plan?.resurrection_backoff ?? false) === true, "insufficient_data → resurrection_backoff true");
  ok(arc.calls.length === 0 && (r.demoted?.length ?? 0) === 0, "fail-safe:冷启动 insufficient_data → 不 demote(零 mutation)");
}
seedWarm();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — forgetting-executor real path: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
