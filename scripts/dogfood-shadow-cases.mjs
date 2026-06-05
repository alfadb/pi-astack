#!/usr/bin/env node
/**
 * dogfood-shadow-cases — generate opportunity-case queries (with oracles) for
 * the time-signal retrieval-shadow dogfood.
 *
 * WHY (per 3-T0 review of P1, 2026-06-05): the env-gated shadow log
 * (PI_ASTACK_MEMORY_TIME_SHADOW=1) records baseline-vs-enhanced Stage2 picks +
 * a `any_high_confidence_maxim_demoted` roll-up. But "did the set change" is not
 * enough to decide the flip — you need an OPPORTUNITY DENOMINATOR (queries that
 * SHOULD exercise the signal) and a manual ORACLE (what good looks like). This
 * script builds that case set deterministically from the REAL store, so a live
 * pi session can run each query under shadow and judge against the oracle.
 *
 * READ-ONLY. Emits JSON cases to stdout (or --out). Does NOT call any LLM.
 *
 * CASE TYPES (the flip gate = §5 of the design note):
 *   - maxim_protection : kind=maxim, confidence>=8. Freshness must NOT demote
 *     these. oracle: expected_protected_slug, should_time_matter=false.
 *   - supersession     : status superseded/deprecated OR superseded_by present.
 *     The superseding/active entry SHOULD win. oracle: expected_fresh_slug,
 *     should_time_matter=true.
 *   - current_state    : most-recently-updated active entries. Freshness MAY
 *     legitimately help. should_time_matter=true.
 *   - negative_control : durable preference/maxim, query without time intent.
 *     Freshness must NOT change ranking. should_time_matter=false.
 *
 * USAGE
 *   node scripts/dogfood-shadow-cases.mjs [--abrain-home <dir>] [--per-type N]
 *        [--json] [--out <file>]
 *   Then in a live pi session: set PI_ASTACK_MEMORY_TIME_SHADOW=1, run each
 *   case.query via memory_search, and join shadow rows by the [case_id] prefix.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2); const n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) a[k] = true; else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const ABRAIN_HOME = path.resolve(args["abrain-home"] || process.env.ABRAIN_HOME || path.join(os.homedir(), ".abrain"));
const PER_TYPE = Math.max(1, Number(args["per-type"] ?? 10));
const OUT = typeof args.out === "string" ? path.resolve(args.out) : null;
const AS_JSON = !!args.json || !!OUT;

// ── load entries from the real store (frontmatter only) ─────────────────
function walk(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
function frontmatterBlock(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}
function scalar(fm, key) {
  const m = fm.match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
  if (!m) return undefined;
  let v = m[1].trim();
  if (v === "[]" || v === "") return undefined;
  return v.replace(/^["']|["']$/g, "");
}
function yamlList(fm, key) {
  // inline "[a, b]" or block "key:\n  - a\n  - b"
  const inline = fm.match(new RegExp("^" + key + ":\\s*\\[(.+)\\]\\s*$", "m"));
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const lines = fm.split("\n");
  const idx = lines.findIndex((l) => new RegExp("^" + key + ":\\s*$").test(l));
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+(.+)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}
function bareSlugOf(ref) {
  // strip project:<id>: / world: / path prefixes → bare slug
  let s = String(ref).trim();
  if (/^project:[^:]+:.+/.test(s)) return s.split(":").slice(2).join(":");
  if (/^project:[^:]+$/.test(s)) return s.slice("project:".length);
  if (/^world:/.test(s)) return s.slice("world:".length);
  if (s.includes("/") || s.endsWith(".md")) return path.basename(s).replace(/\.md$/, "");
  return s;
}

const roots = [path.join(ABRAIN_HOME, "projects"), path.join(ABRAIN_HOME, "knowledge")];
const entries = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, "utf8");
    const fm = frontmatterBlock(text);
    if (!fm) continue;
    const title = scalar(fm, "title") || (text.match(/^#\s+(.+)$/m)?.[1]?.trim()) || path.basename(file, ".md");
    entries.push({
      slug: path.basename(file, ".md"),
      file,
      title,
      kind: scalar(fm, "kind"),
      status: scalar(fm, "status"),
      confidence: Number(scalar(fm, "confidence") ?? "0"),
      created: scalar(fm, "created"),
      updated: scalar(fm, "updated"),
      superseded_by: yamlList(fm, "superseded_by"),
      trigger_phrases: yamlList(fm, "trigger_phrases"),
    });
  }
}

// deterministic ordering
const bySlug = (a, b) => a.slug.localeCompare(b.slug);
const byUpdatedDesc = (a, b) => String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || ""));

// ── build cases ─────────────────────────────────────────────────────────
const cases = [];
let n = 0;
const mk = (type, e, query, extra) => ({ case_id: `time-shadow:${type}:${String(++n).padStart(3, "0")}`, type, seed_slug: e.slug, query, ...extra });

// (a) maxim_protection
for (const e of entries.filter((e) => e.kind === "maxim" && e.confidence >= 8).sort(bySlug).slice(0, PER_TYPE)) {
  const q = (e.trigger_phrases[0] || e.title);
  cases.push(mk("maxim_protection", e, q, { expected_protected_slug: e.slug, should_time_matter: false }));
}
// (b) supersession
for (const e of entries.filter((e) => e.superseded_by.length > 0 || e.status === "superseded" || e.status === "deprecated").sort(bySlug).slice(0, PER_TYPE)) {
  const fresh = e.superseded_by[0] ? bareSlugOf(e.superseded_by[0]) : undefined;
  cases.push(mk("supersession", e, `关于「${e.title}」当前应该按哪个结论执行?`, { ...(fresh ? { expected_fresh_slug: fresh } : {}), should_time_matter: true }));
}
// (c) current_state
for (const e of entries.filter((e) => (e.status === "active" || !e.status)).sort(byUpdatedDesc).slice(0, PER_TYPE)) {
  cases.push(mk("current_state", e, `${e.title} —— 当前实现/状态/下一步是什么?`, { should_time_matter: true }));
}
// (d) negative_control
for (const e of entries.filter((e) => (e.kind === "maxim" || e.kind === "preference") && e.confidence >= 7).sort(bySlug).slice(0, PER_TYPE)) {
  cases.push(mk("negative_control", e, e.title, { expected_protected_slug: e.slug, should_time_matter: false }));
}

const report = {
  generated_at: new Date().toISOString(),
  abrain_home: ABRAIN_HOME,
  entries_scanned: entries.length,
  per_type: PER_TYPE,
  counts: cases.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {}),
  how_to_run: "In a live pi session set PI_ASTACK_MEMORY_TIME_SHADOW=1 (keep memory.search.freshnessSignals=false so live=baseline, shadow=enhanced). Run each case.query via memory_search. Join .pi-astack/memory/search-metrics.jsonl shadow rows. Flip gate: any_high_confidence_maxim_demoted===0 across maxim_protection+negative_control, and supersession/current_state show explainable freshness wins.",
  cases,
};

if (AS_JSON) {
  const text = JSON.stringify(report, null, 2);
  if (OUT) { fs.writeFileSync(OUT, text); process.stdout.write(`wrote ${cases.length} cases to ${OUT}\n`); }
  else process.stdout.write(text + "\n");
} else {
  process.stdout.write(`# dogfood shadow cases\nentries_scanned: ${entries.length}\ncounts: ${JSON.stringify(report.counts)}\n\n`);
  for (const c of cases) {
    process.stdout.write(`[${c.case_id}] should_time_matter=${c.should_time_matter}` +
      `${c.expected_protected_slug ? ` protect=${c.expected_protected_slug}` : ""}` +
      `${c.expected_fresh_slug ? ` fresh=${c.expected_fresh_slug}` : ""}\n  Q: ${c.query}\n`);
  }
}
