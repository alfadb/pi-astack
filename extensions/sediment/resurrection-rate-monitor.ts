// ADR 0031 Phase 2(观测件)— resurrection rate 监控。
//
// 纯确定性读: 把 archive-reactivation 的复活 reviewer ledger
// (`archive-reactivation-ledger.jsonl`)里的 `reactivate` 决策汇总成
// resurrection rate(被复活 / 被审)+ 双窗口趋势。供 Phase 2 的 aggregator
// 自标定与自审闸消费(复活频繁 → 衰减可能过狠 → 调慢)。
//
// 复用既有 ledger(archive-reactivation 已是 LLM 复活 reviewer),不新建
// reactivation 通道/事件流。零行为变化、不写 durable、不调 LLM。
//
// ⚠ 语义守卫(ADR 0031 §2.2 非对称盲区):**低 resurrection rate 不构成
// 「衰减安全」的证明** —— 同源关联偏盲既误降级又压制复活,低复活率可能是
// 「测不到」而非「没问题」。本监控只报告数值;保守解读留给消费方,安全靠
// §2.1 可逆地板,不靠本指标收敛。
import * as fs from "node:fs";
import { archiveReactivationLedgerPath } from "./archive-reactivation";

export interface ReactivationLedgerRow {
  operation?: string;
  slug?: string;
  decision?: string; // keep_archived | reactivate | hard_archive_recommended
  ts?: string;
  project_root?: string;
}

export interface ResurrectionWindowStat {
  window_days: number;
  reviewed: number; // 窗口内 archive_reactivation_decision 行数(被审)
  reactivated: number; // decision === "reactivate"(被复活)
  kept: number; // keep_archived
  hard_archive_reco: number; // hard_archive_recommended
  /** reactivated / reviewed(reviewed=0 时为 0)。 */
  resurrection_rate: number;
}

export interface ResurrectionRateReport {
  generated_at: string;
  total_rows: number;
  recent: ResurrectionWindowStat; // 最近 window_days
  prior: ResurrectionWindowStat; // 前一个等长窗口(趋势对比)
  /** recent.rate − prior.rate(>0 = 复活加速 = 衰减可能过狠;<0 = 减速)。 */
  rate_delta: number;
  trend: "accelerating" | "decelerating" | "stable" | "insufficient_data";
}

const TAIL_BYTES = 4 * 1024 * 1024;
const MIN_REVIEWED_FOR_TREND = 3;
const STABLE_DELTA_EPSILON = 0.05;
const DAY_MS = 86_400_000;

/** best-effort tail 读 ledger(corrupt 行跳过;缺文件返回 [])。 */
export function readReactivationLedgerTail(maxBytes = TAIL_BYTES): ReactivationLedgerRow[] {
  try {
    const file = archiveReactivationLedgerPath();
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    const start = maxBytes > 0 && stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(file, "r");
    let raw = "";
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: ReactivationLedgerRow[] = [];
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try { out.push(JSON.parse(line) as ReactivationLedgerRow); } catch { /* corrupt line skipped */ }
    }
    return out;
  } catch {
    return [];
  }
}

function windowStat(rows: ReactivationLedgerRow[], from: number, to: number, windowDays: number): ResurrectionWindowStat {
  let reviewed = 0, reactivated = 0, kept = 0, hard = 0;
  for (const r of rows) {
    if (r.operation !== "archive_reactivation_decision" || typeof r.ts !== "string") continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < from || t >= to) continue;
    reviewed++;
    if (r.decision === "reactivate") reactivated++;
    else if (r.decision === "keep_archived") kept++;
    else if (r.decision === "hard_archive_recommended") hard++;
  }
  return {
    window_days: windowDays,
    reviewed,
    reactivated,
    kept,
    hard_archive_reco: hard,
    resurrection_rate: reviewed > 0 ? reactivated / reviewed : 0,
  };
}

/** 纯函数: rows + now + windowDays → 双窗口统计 + 趋势(免 IO, 可单测)。 */
export function computeResurrectionRate(rows: ReactivationLedgerRow[], nowMs: number, windowDays: number): ResurrectionRateReport {
  const winMs = Math.max(1, windowDays) * DAY_MS;
  const recent = windowStat(rows, nowMs - winMs, nowMs, windowDays);
  const prior = windowStat(rows, nowMs - 2 * winMs, nowMs - winMs, windowDays);
  const rate_delta = recent.resurrection_rate - prior.resurrection_rate;
  let trend: ResurrectionRateReport["trend"];
  if (recent.reviewed < MIN_REVIEWED_FOR_TREND || prior.reviewed < MIN_REVIEWED_FOR_TREND) {
    trend = "insufficient_data";
  } else if (Math.abs(rate_delta) < STABLE_DELTA_EPSILON) {
    trend = "stable";
  } else {
    trend = rate_delta > 0 ? "accelerating" : "decelerating";
  }
  return {
    generated_at: new Date(nowMs).toISOString(),
    total_rows: rows.length,
    recent,
    prior,
    rate_delta,
    trend,
  };
}

/** 生产读 API: 从 ledger 计算当前 resurrection rate 报告。 */
export function resurrectionRateReport(windowDays = 30, now = new Date()): ResurrectionRateReport {
  return computeResurrectionRate(readReactivationLedgerTail(), now.getTime(), windowDays);
}
