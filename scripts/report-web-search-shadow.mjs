#!/usr/bin/env node
/**
 * Read-only aggregator for the web-search shadow JSONL log
 * (<projectRoot>/.pi-astack/web-search/shadow.jsonl or an explicit file).
 *
 * Aggregates: total rows, provider pairs, ok/error + errorKind counts,
 * primary/shadow latency p50/p95, result counts, overlap/effectiveTopK,
 * and top hostname domains. NEVER prints queries, query digests, raw
 * URLs, snippets, keys or per-row detail — output is aggregates only.
 *
 * Usage:
 *   node scripts/report-web-search-shadow.mjs [--file <path>]
 *   node scripts/report-web-search-shadow.mjs <path>
 *
 * Default file: <cwd>/.pi-astack/web-search/shadow.jsonl
 *
 * Prints a human summary plus one machine-readable line:
 *   REPORT_JSON <json>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_FILE = path.join(process.cwd(), ".pi-astack", "web-search", "shadow.jsonl");

function parseArgs(argv) {
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      file = argv[++i] ?? DEFAULT_FILE;
    } else if (!argv[i].startsWith("-")) {
      file = argv[i];
    }
  }
  return { file };
}

/** Nearest-rank percentile over sorted ascending numbers. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function p50p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    n: sorted.length,
  };
}

function countBy(items) {
  const out = {};
  for (const k of items) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Empty aggregate for a log file that has no samples yet (ENOENT). */
function emptyReport(file) {
  return {
    file,
    totalRows: 0,
    parsedRows: 0,
    okRows: 0,
    errorRows: 0,
    providerPairs: [],
    errorKinds: {},
    primaryLatency: { p50: null, p95: null, n: 0 },
    shadowLatency: { p50: null, p95: null, n: 0 },
    primaryResultCount: { p50: null, p95: null, n: 0 },
    shadowResultCount: { p50: null, p95: null, n: 0 },
    overlap: { p50: null, p95: null, n: 0 },
    effectiveTopK: { p50: null, p95: null, n: 0 },
    topDomains: [],
  };
}

export function aggregateShadowLog(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      // No shadow samples yet — report an empty aggregate (exit 0) instead
      // of failing the whole run. Any other read error still fails.
      return emptyReport(file);
    }
    throw new Error(`cannot read shadow log ${file}: ${e.message}`);
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip malformed lines — report what is parseable */
    }
  }

  const pairCounts = {};
  const okByPair = {};
  const errorKinds = {};
  const primaryLatency = [];
  const shadowLatency = [];
  const primaryCounts = [];
  const shadowCounts = [];
  const overlaps = [];
  const effectiveTopKs = [];
  const domainCounts = {};
  let okRows = 0;
  let errorRows = 0;

  for (const row of rows) {
    const pair = `${row.primaryProvider ?? "?"}->${row.shadowProvider ?? "?"}`;
    pairCounts[pair] = (pairCounts[pair] ?? 0) + 1;
    const shadowStatus = row.shadow?.status;
    if (shadowStatus === "ok") {
      okRows++;
      okByPair[pair] = (okByPair[pair] ?? 0) + 1;
      if (Number.isFinite(row.primary?.latencyMs)) primaryLatency.push(row.primary.latencyMs);
      if (Number.isFinite(row.shadow?.latencyMs)) shadowLatency.push(row.shadow.latencyMs);
      if (Number.isInteger(row.primary?.resultCount)) primaryCounts.push(row.primary.resultCount);
      if (Number.isInteger(row.shadow?.resultCount)) shadowCounts.push(row.shadow.resultCount);
      if (Number.isInteger(row.overlap)) overlaps.push(row.overlap);
      if (Number.isInteger(row.effectiveTopK)) effectiveTopKs.push(row.effectiveTopK);
    } else {
      errorRows++;
      const kind = row.shadow?.errorKind ?? "other";
      errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    }
    for (const d of row.primaryDomains ?? []) {
      if (typeof d === "string") domainCounts[d] = (domainCounts[d] ?? 0) + 1;
    }
    for (const d of row.shadowDomains ?? []) {
      if (typeof d === "string") domainCounts[d] = (domainCounts[d] ?? 0) + 1;
    }
  }

  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([domain, count]) => ({ domain, count }));

  return {
    file,
    totalRows: rows.length,
    parsedRows: rows.length,
    okRows,
    errorRows,
    providerPairs: Object.entries(pairCounts)
      .map(([pair, count]) => ({ pair, count, ok: okByPair[pair] ?? 0 }))
      .sort((a, b) => b.count - a.count),
    errorKinds,
    primaryLatency: p50p95(primaryLatency),
    shadowLatency: p50p95(shadowLatency),
    primaryResultCount: p50p95(primaryCounts),
    shadowResultCount: p50p95(shadowCounts),
    overlap: p50p95(overlaps),
    effectiveTopK: p50p95(effectiveTopKs),
    topDomains,
  };
}

function fmtPct(p) {
  if (!p) return "-";
  return `p50=${p.p50 ?? "-"} p95=${p.p95 ?? "-"} (n=${p.n})`;
}

function main() {
  const { file } = parseArgs(process.argv.slice(2));
  const s = aggregateShadowLog(file);

  console.log(`shadow log: ${s.file}`);
  if (s.totalRows === 0) {
    console.log("  no shadow samples yet");
  }
  console.log(`  rows=${s.totalRows} ok=${s.okRows} error=${s.errorRows}`);
  for (const p of s.providerPairs) {
    console.log(`  provider pair ${p.pair}: total=${p.count} ok=${p.ok}`);
  }
  for (const [kind, count] of Object.entries(s.errorKinds)) {
    console.log(`  errorKind ${kind}: ${count}`);
  }
  console.log(`  primary latency: ${fmtPct(s.primaryLatency)}`);
  console.log(`  shadow latency:  ${fmtPct(s.shadowLatency)}`);
  console.log(`  primary resultCount: ${fmtPct(s.primaryResultCount)}`);
  console.log(`  shadow resultCount:  ${fmtPct(s.shadowResultCount)}`);
  console.log(`  overlap: ${fmtPct(s.overlap)}`);
  console.log(`  effectiveTopK: ${fmtPct(s.effectiveTopK)}`);
  console.log("  top domains:");
  for (const d of s.topDomains) {
    console.log(`    ${d.domain} (${d.count})`);
  }
  console.log(`REPORT_JSON ${JSON.stringify(s)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
