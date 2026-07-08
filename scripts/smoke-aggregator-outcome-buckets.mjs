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
    row({ source: "path-a-injected", session_id: "join-session", turn_id: 9, entry_slug: "joined-slug", path_a_signal: "injection-only" }),
    row({ source: "path-a-injected", session_id: "join-session", turn_id: 2, entry_slug: "no-join-slug", path_a_signal: "injection-only" }),
    row({ source: "memory-footnote" }),
    row({ source: "memory-footnote", session_id: "join-session", turn_id: 9, entry_slug: "joined-slug", used: "decisive", counterfactual: "would have missed the explicit rule" }),
    row({ source: "memory-footnote", session_id: "join-session", turn_id: 3, entry_slug: "no-join-slug", used: "confirmatory", counterfactual: "different turn should not join" }),
    row({ source: "path-a-implicit", entry_slug: "implicit-new", path_a_signal: "injected_no_self_report", path_a_inject_id: "path-a-new" }),
    row({ source: "path-a-implicit", entry_slug: "legacy-implicit", used: "retrieved-unused", counterfactual: "legacy implicit unused", path_a_inject_id: "path-a-legacy" }),
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

  check("activity buckets split retrieval/injection/self-report/Path A rows", () => {
    const b = summary.outcome.activity_buckets;
    if (b.retrieval_only !== 2) throw new Error(`retrieval_only=${b.retrieval_only}`);
    if (b.injection_only !== 2) throw new Error(`injection_only=${b.injection_only}`);
    if (b.self_report !== 2) throw new Error(`self_report=${b.self_report}`);
    if (b.injected_no_self_report !== 1) throw new Error(`injected_no_self_report=${b.injected_no_self_report}`);
    if (b.legacy_implicit_unused !== 1) throw new Error(`legacy_implicit_unused=${b.legacy_implicit_unused}`);
    if (b.derived_attribution !== 1) throw new Error(`derived_attribution=${b.derived_attribution}`);
    if (b.legacy_or_unknown_source !== 1) throw new Error(`legacy_or_unknown_source=${b.legacy_or_unknown_source}`);
  });

  check("observation-only missing used is allowed; memory-footnote missing used is unexpected", () => {
    const m = summary.outcome.missing_used;
    if (m.allowed !== 5) throw new Error(`allowed=${m.allowed}`);
    if (m.unexpected !== 1) throw new Error(`unexpected=${m.unexpected}`);
    if (m.unexpected_sources["memory-footnote"] !== 1) throw new Error(`unexpected_sources=${JSON.stringify(m.unexpected_sources)}`);
    if (m.unexpected_sources["tool-result"] || m.unexpected_sources["source_tool"] || m.unexpected_sources["path-a-injected"] || m.unexpected_sources["path-a-implicit"]) {
      throw new Error(`observation sources leaked into unexpected: ${JSON.stringify(m.unexpected_sources)}`);
    }
  });

  check("legacy summary window excludes injection-only, Path A implicit, and invalid self-report rows", () => {
    if (summary.outcome.activity_window_rows !== 10) throw new Error(`activity_window_rows=${summary.outcome.activity_window_rows}`);
    if (summary.outcome.window_rows !== 4) throw new Error(`window_rows=${summary.outcome.window_rows}`);
    if (summary.outcome.high_unused.length !== 0) throw new Error(`high_unused=${JSON.stringify(summary.outcome.high_unused)}`);
  });

  check("derived attribution joins exposure to self-report without mutating summary rows", () => {
    const d = summary.outcome.derived_attribution;
    if (d.joined_count !== 1) throw new Error(`joined_count=${d.joined_count}`);
    if (d.by_used.decisive !== 1 || d.by_used.confirmatory !== 0 || d.by_used.retrieved_unused !== 0) {
      throw new Error(`by_used=${JSON.stringify(d.by_used)}`);
    }
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
