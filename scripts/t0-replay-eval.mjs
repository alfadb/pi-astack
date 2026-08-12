#!/usr/bin/env node
/**
 * t0-replay-eval — run the t0-eval judge pipeline on a replay dataset with
 * the replay experiment's default judge roles:
 *
 *   evaluator0:     openai/gpt-5.6-sol
 *   evaluator1:     anthropic/claude-opus-5
 *   verifier:       kimi-coding/k3      (temporary paid high-value use — a
 *                                        third vendor, so the adversarial
 *                                        verifier never shares a vendor with
 *                                        either evaluator)
 *   adjudicator:    openai/gpt-5.6-sol
 *   counterfactual: anthropic/claude-opus-5
 *
 * The judge pipeline itself is t0-eval.mjs — this wrapper only injects the
 * replay experiment's default --models (roles in order: evaluator0,
 * evaluator1, verifier, adjudicator, counterfactual). Pass --models to
 * override; all other options are forwarded to t0-eval.mjs unchanged.
 *
 * Usage:
 *   node scripts/t0-replay-eval.mjs [t0-eval options]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t0EvalPath = path.join(__dirname, "t0-eval.mjs");

export const REPLAY_JUDGE_MODELS_CSV = "openai/gpt-5.6-sol,anthropic/claude-opus-5,kimi-coding/k3,openai/gpt-5.6-sol,anthropic/claude-opus-5";

function main() {
  const argv = process.argv.slice(2);
  const hasModels = argv.some((a) => a === "--models");
  const args = hasModels ? argv : ["--models", REPLAY_JUDGE_MODELS_CSV, ...argv];
  const result = spawnSync(process.execPath, [t0EvalPath, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
