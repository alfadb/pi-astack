#!/usr/bin/env node
/**
 * Smoke: outcome-ledger source/activity buckets in sediment aggregator.
 *
 * Locks the 2026-07-08 triage conclusion: missing `used` is not one
 * homogeneous "unknown" class. Retrieval-only and injection-only rows are
 * allowed to omit `used`; self-report-like rows are not.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });

const failures = [];
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("Smoke: aggregator outcome source/activity buckets\n");

const oldAbrainRoot = process.env.ABRAIN_ROOT;
const abrainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-outcome-buckets-abrain-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-outcome-buckets-project-"));
process.env.ABRAIN_ROOT = abrainRoot;

try {
  const ledgerDir = path.join(abrainRoot, ".state", "sediment");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ts = "2026-07-08T12:00:00.000Z";
  const row = (extra) => JSON.stringify({
    ts,
    session_id: "smoke-session",
    entry_slug: extra.entry_slug || "bucket-smoke",
    retrieval_count: 1,
    project_root: projectRoot,
    ...extra,
  });
  fs.writeFileSync(path.join(ledgerDir, "outcome-ledger.jsonl"), [
    row({ source: "tool-result" }),
    row({ source: "source_tool" }),
    row({ source: "path-a-injected", path_a_signal: "injection-only" }),
    row({ source: "memory-footnote" }),
    row({ source: "memory-footnote", used: "decisive", counterfactual: "would have missed the explicit rule" }),
    row({ source: "path-a-implicit", used: "retrieved-unused", counterfactual: "Path A injected this entry but no footnote cited it" }),
    row({ source: "legacy-mystery" }),
  ].join("\n") + "\n", "utf-8");

  const aggregator = jiti(path.join(repoRoot, "extensions/sediment/aggregator.ts"));
  const summary = aggregator.runSedimentAggregator({
    projectRoot,
    settings: { autoLlmWriteEnabled: true },
    now: new Date("2026-07-08T13:00:00.000Z"),
    windowDays: 30,
    outcomeRowLimit: 50,
  });

  check("activity buckets split retrieval/injection/self-report rows", () => {
    const b = summary.outcome.activity_buckets;
    if (b.retrieval_only !== 2) throw new Error(`retrieval_only=${b.retrieval_only}`);
    if (b.injection_only !== 1) throw new Error(`injection_only=${b.injection_only}`);
    if (b.self_report !== 1) throw new Error(`self_report=${b.self_report}`);
    if (b.implicit_unused !== 1) throw new Error(`implicit_unused=${b.implicit_unused}`);
    if (b.legacy_or_unknown_source !== 1) throw new Error(`legacy_or_unknown_source=${b.legacy_or_unknown_source}`);
  });

  check("tool-result/source_tool/path-a-injected missing used is allowed, not unexpected", () => {
    const m = summary.outcome.missing_used;
    if (m.allowed !== 3) throw new Error(`allowed=${m.allowed}`);
    if (m.unexpected !== 1) throw new Error(`unexpected=${m.unexpected}`);
    if (m.unexpected_sources["memory-footnote"] !== 1) throw new Error(`unexpected_sources=${JSON.stringify(m.unexpected_sources)}`);
    if (m.unexpected_sources["tool-result"] || m.unexpected_sources["source_tool"] || m.unexpected_sources["path-a-injected"]) {
      throw new Error(`retrieval/injection sources leaked into unexpected: ${JSON.stringify(m.unexpected_sources)}`);
    }
  });

  check("legacy summary window excludes injection-only and invalid self-report rows", () => {
    if (summary.outcome.activity_window_rows !== 7) throw new Error(`activity_window_rows=${summary.outcome.activity_window_rows}`);
    if (summary.outcome.window_rows !== 4) throw new Error(`window_rows=${summary.outcome.window_rows}`);
  });

  check("source_counts keeps per-source observability", () => {
    const s = summary.outcome.source_counts;
    for (const key of ["tool-result", "source_tool", "path-a-injected", "memory-footnote", "path-a-implicit", "legacy-mystery"]) {
      if (!s[key]) throw new Error(`missing source_counts[${key}] in ${JSON.stringify(s)}`);
    }
  });
} finally {
  if (oldAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = oldAbrainRoot;
  fs.rmSync(abrainRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

console.log(`\nTotal: ${total}  Passed: ${total - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — outcome activity buckets drifted.");
  process.exit(1);
}
