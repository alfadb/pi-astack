/**
 * ADR 0031 Phase 2 — resurrection-rate-monitor deterministic 单测(免 LLM/IO)。
 * 测 computeResurrectionRate 纯函数:双窗口(recent/prior)计数 + resurrection_rate +
 * 趋势分类(accelerating/decelerating/stable/insufficient_data)+ 窗口边界 + 脏数据忽略。
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { computeResurrectionRate } = await jiti.import(path.join(__dirname, "..", "extensions/sediment/resurrection-rate-monitor.ts"));

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

const NOW = Date.parse("2026-06-15T00:00:00Z");
const DAY = 86_400_000;
let _seq = 0;
const row = (decision, daysAgo, op = "archive_reactivation_decision") =>
  ({ operation: op, slug: `s${_seq++}`, decision, ts: new Date(NOW - daysAgo * DAY).toISOString() });

// 空 ledger
{
  const r = computeResurrectionRate([], NOW, 30);
  ok(r.recent.reviewed === 0 && r.recent.resurrection_rate === 0, "空 ledger → reviewed=0 rate=0");
  ok(r.trend === "insufficient_data", "空 → insufficient_data");
}

// recent 窗口分类计数 + rate
{
  const rows = [row("reactivate", 1), row("reactivate", 2), row("keep_archived", 3), row("keep_archived", 4), row("hard_archive_recommended", 5)];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(r.recent.reviewed === 5, "recent reviewed=5");
  ok(r.recent.reactivated === 2 && r.recent.kept === 2 && r.recent.hard_archive_reco === 1, "三类决策分别计数正确");
  ok(Math.abs(r.recent.resurrection_rate - 0.4) < 1e-9, "resurrection_rate=2/5=0.4");
}

// 窗口边界: 35 天前落在 prior(30-60d), 不进 recent(0-30d)
{
  const rows = [row("reactivate", 1), row("reactivate", 35)];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(r.recent.reviewed === 1, "35 天前不计入 recent");
  ok(r.prior.reviewed === 1, "35 天前计入 prior");
}

// 趋势: accelerating(recent 0.75 > prior 0.25)→ 复活加速 = 衰减可能过狠
{
  const rows = [
    row("reactivate", 5), row("reactivate", 6), row("reactivate", 7), row("keep_archived", 8),
    row("reactivate", 35), row("keep_archived", 36), row("keep_archived", 37), row("keep_archived", 38),
  ];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(Math.abs(r.recent.resurrection_rate - 0.75) < 1e-9 && Math.abs(r.prior.resurrection_rate - 0.25) < 1e-9, "recent=0.75 prior=0.25");
  ok(r.rate_delta > 0 && r.trend === "accelerating", "复活加速 → accelerating");
}

// 趋势: decelerating(recent 0.25 < prior 0.75)
{
  const rows = [
    row("keep_archived", 5), row("keep_archived", 6), row("keep_archived", 7), row("reactivate", 8),
    row("reactivate", 35), row("reactivate", 36), row("reactivate", 37), row("keep_archived", 38),
  ];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(r.rate_delta < 0 && r.trend === "decelerating", "复活减速 → decelerating");
}

// 趋势: stable(delta < epsilon 0.05)
{
  const rows = [
    row("reactivate", 5), row("keep_archived", 6), row("keep_archived", 7), row("keep_archived", 8),
    row("reactivate", 35), row("keep_archived", 36), row("keep_archived", 37), row("keep_archived", 38),
  ];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(Math.abs(r.rate_delta) < 0.05 && r.trend === "stable", "delta≈0 → stable");
}

// insufficient: recent reviewed < 3
{
  const rows = [row("reactivate", 1), row("keep_archived", 2), row("reactivate", 35), row("keep_archived", 36), row("keep_archived", 37)];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(r.recent.reviewed === 2 && r.trend === "insufficient_data", "recent reviewed<3 → insufficient_data");
}

// 脏数据: 非 decision op + 坏 ts 被忽略
{
  const rows = [
    row("reactivate", 1),
    { operation: "other_op", decision: "reactivate", ts: new Date(NOW).toISOString() },
    { operation: "archive_reactivation_decision", decision: "reactivate", ts: "not-a-date" },
  ];
  const r = computeResurrectionRate(rows, NOW, 30);
  ok(r.recent.reviewed === 1, "非 decision op + 坏 ts 被忽略");
}

console.log(fails === 0
  ? "\n✅ ALL PASS — resurrection-rate-monitor: 双窗口计数 + 趋势分类 + 边界 + 脏数据"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
