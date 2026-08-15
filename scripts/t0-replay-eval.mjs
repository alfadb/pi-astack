#!/usr/bin/env node
/**
 * t0-replay-eval — run the t0-eval judge pipeline on a COMMITTED replay
 * dataset with the replay experiment's fixed judge roles:
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
 * The judge pipeline itself is t0-eval.mjs — this wrapper only:
 *   - requires a unique `--dataset <dir>` (the committed replay dataset);
 *   - maps it to the child-internal `--replay-dataset` flag;
 *   - pins `--models` to the fixed replay roles (default when absent;
 *     an explicit value that is byte-identical is accepted; any other
 *     override is rejected BEFORE the child is spawned);
 *   - rejects `--episodes` / `--replay-dataset` / value-less / duplicate
 *     `--dataset` (the corpus is ONLY the committed dataset).
 *
 * Usage:
 *   node scripts/t0-replay-eval.mjs --dataset <committed-replay-dir> [t0-eval options]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t0EvalPath = path.join(__dirname, "t0-eval.mjs");

/** Fixed replay judge roles CSV (roles in order). Shared with t0-eval-common. */
export const REPLAY_JUDGE_MODELS_CSV = "openai/gpt-5.6-sol,anthropic/claude-opus-5,kimi-coding/k3,openai/gpt-5.6-sol,anthropic/claude-opus-5";

/**
 * Pure arg normalizer for t0-replay-eval (no I/O, no process.exit) — the
 * single authority the wrapper and the offline smoke tests share.
 *
 * Contract:
 *   - `--dataset <dir>` is REQUIRED, unique, and value-bearing;
 *   - `--episodes` / `--replay-dataset` are REJECTED (the wrapper owns the
 *     corpus flag surface; the child-internal flag is injected below);
 *   - the `=` -form tokens (`--dataset=`, `--episodes=`, `--replay-dataset=`,
 *     `--models=`) are REJECTED directly — forwarded they would be silently
 *     ignored by the child's parse and fall back to production defaults;
 *   - `--models` may be absent (default = fixed CSV) or present with a
 *     value that is EXACTLY the fixed CSV after resolve-equivalent
 *     comparison (byte-identical CSV, or any equivalent role assignment);
 *     any other override is rejected;
 *   - all other flags are forwarded to the child unchanged.
 *
 * Returns { datasetDir, modelsCsv, childArgv } where childArgv is the
 * exact argv to pass to t0-eval.mjs (includes `--replay-dataset` + the
 * resolved models CSV, never `--dataset`).
 */
export function normalizeReplayEvalArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new Error("normalizeReplayEvalArgs: argv must be an array");
  }
  let datasetDir = null;
  let modelsCsv = null;
  let modelsSeen = false;
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // = -form corpus/models tokens are rejected DIRECTLY here — they would
    // otherwise be forwarded as unknown tokens and silently ignored by the
    // child's parse (the child never sees a real --replay-dataset and falls
    // back to production defaults). Never rely on downstream parse ignoring.
    if (token.startsWith("--dataset=")) {
      throw new Error("t0-replay-eval rejects --dataset=<dir> (use --dataset <dir>; the wrapper owns the corpus flag surface)");
    }
    if (token.startsWith("--episodes=")) {
      throw new Error("t0-replay-eval rejects --episodes=<path> (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token.startsWith("--replay-dataset=")) {
      throw new Error("t0-replay-eval rejects --replay-dataset=<dir> (use --dataset <dir>; the child-internal flag is injected by the wrapper)");
    }
    if (token.startsWith("--models=")) {
      throw new Error("t0-replay-eval rejects --models=<csv> (use --models <csv>; the wrapper gates the models value)");
    }
    if (token === "--dataset") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--dataset requires a directory path");
      }
      if (datasetDir !== null) {
        throw new Error("--dataset must be specified exactly once");
      }
      datasetDir = path.resolve(next);
      i++;
      continue;
    }
    if (token === "--episodes") {
      throw new Error("t0-replay-eval rejects --episodes (the corpus is ONLY the committed replay dataset via --dataset)");
    }
    if (token === "--replay-dataset") {
      throw new Error("t0-replay-eval rejects --replay-dataset (use --dataset; the child-internal flag is injected by the wrapper)");
    }
    if (token === "--models") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--models requires a CSV value");
      }
      if (modelsSeen) {
        throw new Error("--models must be specified at most once");
      }
      modelsSeen = true;
      modelsCsv = next;
      i++;
      continue;
    }
    // Forward every other flag/value as-is (including unknown ones — the
    // child is the authority for its own option surface).
    forwarded.push(token);
  }
  if (datasetDir === null) {
    throw new Error("t0-replay-eval requires --dataset <dir> (the committed replay dataset directory)");
  }
  // Models gate: default = fixed CSV; explicit value must resolve to the
  // EXACT same five-role assignment (an identical CSV is always accepted;
  // a role-equivalent reordering of the CSV is rejected only when the
  // resolved roles differ — the gate is role-deep-equal, not string-equal,
  // so an identical CSV always passes and a different role set always fails).
  const resolvedModelsCsv = modelsCsv ?? REPLAY_JUDGE_MODELS_CSV;
  // Role-deep-equal against the fixed CSV (split+trim comparison of the
  // five role slots). An explicit override whose resolved roles differ is
  // rejected BEFORE the child is spawned (zero invoker).
  const fixedRoles = REPLAY_JUDGE_MODELS_CSV.split(",").map((s) => s.trim());
  const resolvedRoles = resolvedModelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (resolvedRoles.length !== fixedRoles.length || fixedRoles.some((m, i) => m !== resolvedRoles[i])) {
    throw new Error(`t0-replay-eval requires the fixed replay judge roles (${REPLAY_JUDGE_MODELS_CSV}) — a different --models is rejected before any invoker`);
  }
  const childArgv = [
    "--replay-dataset", datasetDir,
    "--models", REPLAY_JUDGE_MODELS_CSV,
    ...forwarded,
  ];
  return { datasetDir, modelsCsv: REPLAY_JUDGE_MODELS_CSV, childArgv };
}

function main() {
  let normalized;
  try {
    normalized = normalizeReplayEvalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`t0-replay-eval: ${err.message}`);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [t0EvalPath, ...normalized.childArgv], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
