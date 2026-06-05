#!/usr/bin/env node
/**
 * audit-usability-report — P0 deliverable for the "时间维度决策信号" design
 * (docs/notes/2026-06-05-timeline-audit-decision-signals-design.md §6 P0).
 *
 * PURPOSE
 *   The design note proposes building churn / attention / lifecycle signals
 *   on top of `audit.jsonl` (richer + less survivorship-biased than the
 *   per-entry `## Timeline`). But 3×T0 blind review flagged that audit.jsonl
 *   is NOT a clean foundation: heterogeneous schema, silent dropped rows,
 *   missing causal anchors on some lanes, git history in a *different* repo.
 *
 *   So before audit becomes a foundation, it must be an AUDITED OBJECT.
 *   This script reads the REAL audit streams (bounded tail, read-only) and
 *   reports empirical coverage so we can decide — with numbers, not
 *   assumptions — whether/where audit-derived signals are trustworthy.
 *
 * READ-ONLY / ZERO-RISK
 *   - Never writes anything unless you pass `--out <path>` explicitly.
 *   - Bounded tail read (default 2MB, mirrors aggregator.ts JSONL_TAIL_READ_BYTES)
 *     so it never loads an unbounded append-only stream into memory.
 *
 * SOURCES (paths mirror extensions/_shared/runtime.ts)
 *   - project: <projectRoot>/.pi-astack/sediment/audit.jsonl   (sedimentAuditPath)
 *   - abrain : <abrainHome>/.state/sediment/audit.jsonl        (abrainSedimentAuditPath)
 *
 * USAGE
 *   node scripts/audit-usability-report.mjs \
 *     [--project-root <dir>] [--abrain-home <dir>] \
 *     [--project-audit <file>] [--abrain-audit <file>] \
 *     [--window-days <n>] [--max-bytes <n>] [--json] [--out <file>]
 *
 *   Defaults: project-root = $PI_PROJECT_ROOT || cwd ; abrain-home = $ABRAIN_HOME || ~/.abrain
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── arg parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const PROJECT_ROOT = path.resolve(args["project-root"] || process.env.PI_PROJECT_ROOT || process.cwd());
const ABRAIN_HOME = path.resolve(args["abrain-home"] || process.env.ABRAIN_HOME || path.join(os.homedir(), ".abrain"));
const PROJECT_AUDIT = args["project-audit"]
  ? path.resolve(args["project-audit"])
  : path.join(PROJECT_ROOT, ".pi-astack", "sediment", "audit.jsonl");
const ABRAIN_AUDIT = args["abrain-audit"]
  ? path.resolve(args["abrain-audit"])
  : path.join(ABRAIN_HOME, ".state", "sediment", "audit.jsonl");
const WINDOW_DAYS = Number(args["window-days"] ?? 30);
const MAX_BYTES = Number(args["max-bytes"] ?? 2 * 1024 * 1024);
const AS_JSON = !!args.json;
const OUT = typeof args.out === "string" ? path.resolve(args.out) : null;

// ── bounded JSONL reader (mirrors aggregator.ts readJsonl semantics) ────
function readJsonlTail(filePath, maxBytes = MAX_BYTES) {
  if (!fs.existsSync(filePath)) return { exists: false, rows: [], corrupt: 0, bytes: 0, truncated: false };
  const stat = fs.statSync(filePath);
  const start = maxBytes > 0 && stat.size > maxBytes ? stat.size - maxBytes : 0;
  const fd = fs.openSync(filePath, "r");
  let raw = "";
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    raw = buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
  // discard first partial line if we started mid-file
  if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let corrupt = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { corrupt++; }
  }
  return { exists: true, rows, corrupt, bytes: stat.size, truncated: start > 0 };
}

// ── presence / classification helpers ──────────────────────────────────
// present = key exists AND value is not null/undefined/"". NOTE: turn_id can
// legitimately be the NUMBER 0 (present!), so we must not use truthiness.
const present = (row, k) => {
  const v = row[k];
  return v !== undefined && v !== null && v !== "";
};

// mutation ops = lifecycle-bearing rows (what churn / lifecycle signals need).
const MUTATION_OPS = new Set(["create", "update", "merge", "archive", "supersede", "delete"]);
// churn ops = revisions only (per design §3B; create=birth, not churn).
const CHURN_OPS = new Set(["update", "merge", "supersede"]);

function opOf(row) { return typeof row.operation === "string" ? row.operation : "(missing)"; }

// identity key: rows use `target` (multiple shapes) OR `slug`. Classify target.
// Empirically (P0 run 2026-06-05) `target` has FOUR shapes, incl. a LEGACY
// 2-part `project:<slug>` form predating project-id binding. A slug-parser
// MUST handle all four or it silently drops ~40% of historical mutation rows.
function targetShape(t) {
  if (typeof t !== "string" || !t) return "(none)";
  if (/^project:[^:]+:.+/.test(t)) return "project:<id>:<slug>";
  if (/^project:[^:]+$/.test(t)) return "project:<slug> (legacy 2-part)";
  if (/^world:/.test(t)) return "world:<slug>";
  if (/^projects?\//.test(t) || t.endsWith(".md")) return "path";
  return "other";
}
function slugFromRow(row) {
  if (present(row, "slug")) return String(row.slug);
  const t = typeof row.target === "string" ? row.target : "";
  if (/^project:[^:]+:.+/.test(t)) return t.split(":").slice(2).join(":");
  if (/^project:[^:]+$/.test(t)) return t.slice("project:".length);
  if (/^world:/.test(t)) return t.slice("world:".length);
  if (/^projects?\//.test(t) || t.endsWith(".md")) return path.basename(t).replace(/\.md$/, "");
  return null;
}

function countBy(rows, fn) {
  const m = {};
  for (const r of rows) { const k = fn(r); m[k] = (m[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}
const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

// ── per-source analysis ─────────────────────────────────────────────────
function analyze(label, filePath, cutoffMs) {
  const { exists, rows, corrupt, bytes, truncated } = readJsonlTail(filePath);
  if (!exists) return { label, filePath, exists: false };

  const withTs = rows.filter((r) => typeof (r.timestamp ?? r.ts) === "string");
  const recent = withTs.filter((r) => {
    const ms = Date.parse(r.timestamp ?? r.ts);
    return Number.isFinite(ms) && ms >= cutoffMs;
  });
  const mut = rows.filter((r) => MUTATION_OPS.has(opOf(r)));
  const churn = rows.filter((r) => CHURN_OPS.has(opOf(r)));
  const rejects = rows.filter((r) => opOf(r) === "reject");

  const anchorCov = (subset) => ({
    n: subset.length,
    session_id: pct(subset.filter((r) => present(r, "session_id")).length, subset.length),
    turn_id: pct(subset.filter((r) => present(r, "turn_id")).length, subset.length),
    correlation_id: pct(subset.filter((r) => present(r, "correlation_id")).length, subset.length),
  });

  // joinability: among mutation rows, can we recover a slug (target|slug)?
  const mutJoinable = mut.filter((r) => slugFromRow(r) !== null).length;

  return {
    label, filePath, exists: true,
    bytes, truncated, rows_in_tail: rows.length, corrupt_rows: corrupt,
    rows_missing_timestamp: rows.length - withTs.length,
    window_days: WINDOW_DAYS, recent_rows: recent.length,
    operations: countBy(rows, opOf),
    lanes: countBy(rows, (r) => (typeof r.lane === "string" ? r.lane : "(none)")),
    anchor_all: anchorCov(rows),
    anchor_mutation: anchorCov(mut),
    anchor_churn: anchorCov(churn),
    target_shapes: countBy(rows.filter((r) => present(r, "target") || present(r, "slug")),
      (r) => (present(r, "slug") ? "slug-field" : targetShape(r.target))),
    mutation_rows: mut.length,
    churn_rows: churn.length,
    mutation_joinable_pct: pct(mutJoinable, mut.length),
    reject_reasons: countBy(rejects, (r) => (typeof r.reason === "string" ? r.reason : "(no reason)")),
  };
}

// ── verdict heuristic ────────────────────────────────────────────────────
function verdict(project, abrain) {
  const v = [];
  const P = project?.exists ? project : null;
  const A = abrain?.exists ? abrain : null;

  if (P) {
    const tj = P.anchor_mutation.turn_id;
    if (P.churn_rows >= 10) v.push(`✅ project churn computable: ${P.churn_rows} churn rows (update/merge/supersede) in tail — counts are timing-invariant, usable.`);
    else v.push(`⚠️ project churn sparse: only ${P.churn_rows} churn rows in tail — low statistical power.`);
    if (tj >= 70) v.push(`✅ project turn_id coverage on mutation rows = ${tj}% — decision-turn join viable on most lifecycle events.`);
    else v.push(`⚠️ project turn_id coverage on mutation rows = ${tj}% — turn-level attribution only on covered subset; rest falls back to session/timestamp.`);
    if (P.mutation_joinable_pct >= 95) v.push(`✅ project slug joinable = ${P.mutation_joinable_pct}% of mutation rows (target|slug) — slug-parse must handle ${Object.keys(P.target_shapes).length} shapes.`);
    else v.push(`⚠️ project slug joinable only ${P.mutation_joinable_pct}% — some mutation rows have no recoverable identity.`);
  } else v.push("ℹ️ no project audit found.");

  if (A) {
    v.push(`⚠️ abrain-lane turn_id coverage (all rows) = ${A.anchor_all.turn_id}% — world/workflow lane attention/decision-turn analysis is unreliable; restrict to session_id (${A.anchor_all.session_id}%).`);
  } else v.push("ℹ️ no abrain audit found.");

  v.push("ℹ️ timestamps are WRITE-time (sediment batch), not decision wall-clock; turn_id is the trigger-turn. Use for 'recently touched', not precise attention time.");
  v.push("ℹ️ silent dropped rows (success-path audit after commit; fire-and-forget diagnostics) + hard-delete history live only in the abrain git repo — NOT measurable from audit.jsonl alone.");
  return v;
}

// ── render ───────────────────────────────────────────────────────────────
function topN(obj, n = 12) {
  return Object.entries(obj).slice(0, n).map(([k, vv]) => `    ${k}: ${vv}`).join("\n");
}
function renderSource(s) {
  if (!s) return "";
  if (!s.exists) return `### ${s.label}\n  (not found: ${s.filePath})\n`;
  return [
    `### ${s.label}`,
    `  file: ${s.filePath}`,
    `  bytes: ${s.bytes}  tail_truncated: ${s.truncated}  rows_in_tail: ${s.rows_in_tail}  corrupt: ${s.corrupt_rows}  missing_ts: ${s.rows_missing_timestamp}`,
    `  recent_rows (${s.window_days}d): ${s.recent_rows}`,
    `  mutation_rows: ${s.mutation_rows}  churn_rows: ${s.churn_rows}  mutation_joinable: ${s.mutation_joinable_pct}%`,
    `  anchor coverage [all]      : session=${s.anchor_all.session_id}% turn=${s.anchor_all.turn_id}% corr=${s.anchor_all.correlation_id}% (n=${s.anchor_all.n})`,
    `  anchor coverage [mutation] : session=${s.anchor_mutation.session_id}% turn=${s.anchor_mutation.turn_id}% corr=${s.anchor_mutation.correlation_id}% (n=${s.anchor_mutation.n})`,
    `  anchor coverage [churn]    : session=${s.anchor_churn.session_id}% turn=${s.anchor_churn.turn_id}% corr=${s.anchor_churn.correlation_id}% (n=${s.anchor_churn.n})`,
    `  identity (target shapes / slug):\n${topN(s.target_shapes)}`,
    `  operations:\n${topN(s.operations)}`,
    `  lanes:\n${topN(s.lanes)}`,
    s.reject_reasons && Object.keys(s.reject_reasons).length ? `  reject reasons:\n${topN(s.reject_reasons)}` : `  reject reasons: (none in tail)`,
    "",
  ].join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────
const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
const project = analyze("project audit", PROJECT_AUDIT, cutoffMs);
const abrain = analyze("abrain audit", ABRAIN_AUDIT, cutoffMs);
const report = {
  generated_at: new Date().toISOString(),
  window_days: WINDOW_DAYS,
  max_bytes: MAX_BYTES,
  project_root: PROJECT_ROOT,
  abrain_home: ABRAIN_HOME,
  sources: { project, abrain },
  verdict: verdict(project, abrain),
};

if (AS_JSON) {
  const text = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, text);
  else process.stdout.write(text + "\n");
} else {
  const out = [
    "# audit.jsonl usability report (P0)",
    `generated_at: ${report.generated_at}`,
    `window_days: ${WINDOW_DAYS}  max_bytes: ${MAX_BYTES}`,
    `project_root: ${PROJECT_ROOT}`,
    `abrain_home:  ${ABRAIN_HOME}`,
    "",
    renderSource(project),
    renderSource(abrain),
    "## verdict",
    ...report.verdict.map((l) => `- ${l}`),
    "",
  ].join("\n");
  process.stdout.write(out);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}
