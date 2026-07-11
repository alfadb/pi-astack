#!/usr/bin/env node
/** Fresh-process durable-boundary worker for P1-B production trace replay. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const replay = jiti(path.join(repoRoot, "extensions/_shared/production-trace-replay.ts"));

if (process.argv.length !== 3) {
  console.error("worker requires exactly one temporary scenario config JSON path");
  process.exit(64);
}

try {
  const { exitCode } = await replay.executeProductionTraceWorkerConfig(process.argv[2]);
  process.exit(exitCode);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(70);
}
