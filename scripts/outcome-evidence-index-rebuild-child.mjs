#!/usr/bin/env node
/**
 * Fixed child entry for production-live outcome-evidence index rebuild.
 * Runs the existing synchronous rebuildOutcomeEvidenceIndex off the pi main
 * event loop. Argv is a closed protocol: absolute --abrain-home only (plus
 * optional smoke-only --test-busy-ms). No shell, no source/user content.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const CHILD_SCHEMA = "outcome-evidence-index-rebuild-child-result/v1";
const MAX_ARG_BYTES = 4096;
const MAX_ERROR_CHARS = 2048;
const DIAGNOSTICS_CAP = 32;
const MAX_BUSY_MS = 30_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

function emit(value, exitCode) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function parseArgs(argv) {
  if (argv.length > 6 || argv.some((value) => Buffer.byteLength(value) > MAX_ARG_BYTES || value.includes("\0"))) {
    fail("CHILD_ARG_INVALID", "child argv exceeds the closed bounded protocol");
  }
  const allowed = new Set(["--abrain-home", "--test-busy-ms"]);
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || parsed.has(key)) {
      fail("CHILD_ARG_INVALID", "child argv contains an unknown, duplicate, or valueless option");
    }
    parsed.set(key, value);
  }
  const abrainHome = parsed.get("--abrain-home");
  if (!abrainHome || !path.isAbsolute(abrainHome)) {
    fail("CHILD_ARG_INVALID", "child requires absolute --abrain-home");
  }
  const busyRaw = parsed.get("--test-busy-ms");
  const busyMs = busyRaw === undefined ? 0 : Number(busyRaw);
  if (!Number.isSafeInteger(busyMs) || busyMs < 0 || busyMs > MAX_BUSY_MS) {
    fail("CHILD_ARG_INVALID", "child --test-busy-ms out of bounds");
  }
  return { abrainHome: path.resolve(abrainHome), busyMs };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.busyMs > 0) {
    // Smoke-only synthetic load so parent event-loop tickers can prove progress.
    const until = performance.now() + options.busyMs;
    while (performance.now() < until) { /* intentional busy wait in child only */ }
  }

  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(packageRoot, { interopDefault: true });
  const outcome = jiti(path.join(packageRoot, "extensions/sediment/outcome-evidence.ts"));

  const started = performance.now();
  const rebuilt = outcome.rebuildOutcomeEvidenceIndex(options.abrainHome);
  const wall_time_ms = Math.max(0, Math.round(performance.now() - started));
  const diagnostics = Array.isArray(rebuilt.diagnostics) ? rebuilt.diagnostics : [];
  emit({
    schema_version: CHILD_SCHEMA,
    ok: rebuilt.ok === true,
    rows: typeof rebuilt.rows === "number" ? rebuilt.rows : 0,
    candidates: typeof rebuilt.candidates === "number" ? rebuilt.candidates : 0,
    diagnostics: diagnostics.slice(0, DIAGNOSTICS_CAP),
    diagnostics_total: diagnostics.length,
    diagnostics_truncated: diagnostics.length > DIAGNOSTICS_CAP,
    error: typeof rebuilt.error === "string" && rebuilt.error ? rebuilt.error : null,
    wall_time_ms,
    pid: process.pid,
  }, 0);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code).slice(0, 128)
    : "CHILD_FAILED";
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
  emit({
    schema_version: CHILD_SCHEMA,
    ok: false,
    rows: 0,
    candidates: 0,
    diagnostics: [],
    diagnostics_total: 0,
    diagnostics_truncated: false,
    error: `${code}:${message}`,
    wall_time_ms: 0,
    pid: process.pid,
  }, 1);
}
