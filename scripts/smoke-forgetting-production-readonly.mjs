#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const abrain = "/home/worker/.abrain";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS:", msg); } else { fail++; console.error("FAIL:", msg); } };

if (!fs.existsSync(abrain)) {
  console.log("SKIP: /home/worker/.abrain does not exist");
  process.exit(0);
}

const validEvidence = new Set(["superseded_by", "contradicted", "version_stale"]);
const usageOnly = new Set(["", "usage_only", "usage-only", "disuse", "retrieval_only", "retrieval-only", "kind_atypical", "low_citation", "low-citations"]);
const readJsonl = (file) => fs.existsSync(file)
  ? fs.readFileSync(file, "utf-8").split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : [];

const decayLedger = path.join(abrain, ".state", "sediment", "decay-shadow.jsonl");
const decayRows = readJsonl(decayLedger);
const usageOnlyWouldDemote = decayRows.filter((row) => row.would_demote === true && (!validEvidence.has(String(row.demote_evidence_type ?? "")) || usageOnly.has(String(row.demote_evidence_type ?? ""))));
const usageOnlyViolations = decayRows.filter((row) => row.violation_reason === "would_demote_usage_only");
ok(usageOnlyWouldDemote.length === 0, `historical decay-shadow usage-only would_demote rows = ${usageOnlyWouldDemote.length}`);
ok(usageOnlyViolations.length === 0, `decay-shadow would_demote_usage_only violation rows = ${usageOnlyViolations.length}`);

let archivedFrontmatterCount = 0;
const skipDirs = new Set([".git", ".state", "vault", "staging", "workflows", "rules"]);
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (skipDirs.has(ent.name)) continue;
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(file); continue; }
    if (!ent.isFile() || !file.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
      if (/^---\n[\s\S]*?^status:\s*archived\s*$/m.test(raw)) archivedFrontmatterCount++;
    } catch { /* ignore unreadable markdown */ }
  }
};
walk(abrain);
ok(archivedFrontmatterCount > 0, `archived L2 tombstones with status: archived frontmatter = ${archivedFrontmatterCount}`);

process.env.ABRAIN_ROOT = abrain;
const jiti = createJiti(import.meta.url);
const { kindDistributionReport } = await jiti.import(path.join(repoRoot, "extensions/sediment/kind-distribution-monitor.ts"));
const report = kindDistributionReport(undefined, abrain);
ok(Number.isFinite(report.active_total) && Number.isFinite(report.archived_total), "kind distribution report returns finite totals");
ok(Array.isArray(report.buckets), `kind distribution buckets computed (${report.buckets.length})`);
console.log(`kind distribution: active=${report.active_total} archived=${report.archived_total} alerts=${report.alerts.length}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAIL"} — forgetting production readonly: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
