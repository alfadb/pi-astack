#!/usr/bin/env node
/**
 * Append material hub judgment rows. Pure JSONL backfill; no LLM calls.
 */

import fs from "node:fs";
import path from "node:path";

const OUT_FILE = "/home/worker/.pi/.pi-astack/dispatch/hub-judgments.jsonl";
const VALID_VERDICTS = new Set(["hub_better", "human_better", "tie", "invalid"]);

function valuesFor(args, name) {
  const prefix = `--${name}=`;
  return args.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function one(args, name) {
  const values = valuesFor(args, name);
  return values.length ? values[values.length - 1] : "";
}

function usage() {
  return [
    "Usage:",
    "  node scripts/hub-judgment-backfill.mjs --run=<hub_run_id> --verdict=<hub_better|human_better|tie|invalid> --judge=<provider/model> [--judge=<provider/model>] [--notes=<text>]",
  ].join("\n");
}

const args = process.argv.slice(2);
const hubRunId = one(args, "run").trim();
const finalVerdict = one(args, "verdict").trim();
const judges = valuesFor(args, "judge").map((judge) => judge.trim()).filter(Boolean);
const notes = one(args, "notes");

if (!hubRunId || !VALID_VERDICTS.has(finalVerdict) || judges.length === 0) {
  console.error(usage());
  process.exit(2);
}

const row = {
  ts: new Date().toISOString(),
  hub_run_id: hubRunId,
  mode: "material",
  judges,
  final_verdict: finalVerdict,
  notes,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.appendFileSync(OUT_FILE, `${JSON.stringify(row)}\n`, "utf-8");
console.log(`hub-judgment-backfill: appended ${hubRunId} -> ${finalVerdict} (${judges.length} judge${judges.length === 1 ? "" : "s"})`);
