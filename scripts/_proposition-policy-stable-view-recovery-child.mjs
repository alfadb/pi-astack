#!/usr/bin/env node
/** Bounded child boundary for deterministic stable-view compile/publication. */
import path from "node:path";
import { createRequire } from "node:module";

const CHILD_SCHEMA = "proposition-policy-stable-view-recovery-child-result/v1";
const MAX_ARG_BYTES = 4096;
const MAX_ERROR_CHARS = 2048;

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function parseArgs(argv) {
  if (argv.length > 10 || argv.some((value) => Buffer.byteLength(value) > MAX_ARG_BYTES || value.includes("\0"))) {
    fail("RECOVERY_CHILD_ARG_INVALID", "child argv exceeds the closed bounded protocol");
  }
  const allowed = new Set(["--abrain-home", "--repo-root", "--attempt", "--test-source-race-until", "--test-busy-ms"]);
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined || parsed.has(key)) {
      fail("RECOVERY_CHILD_ARG_INVALID", "child argv contains an unknown, duplicate, or valueless option");
    }
    parsed.set(key, value);
  }
  const abrainHome = parsed.get("--abrain-home");
  const repoRoot = parsed.get("--repo-root");
  const attempt = Number(parsed.get("--attempt"));
  if (!abrainHome || !repoRoot || !path.isAbsolute(abrainHome) || !path.isAbsolute(repoRoot)
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    fail("RECOVERY_CHILD_ARG_INVALID", "child root paths or attempt are invalid");
  }
  const sourceRaceUntil = Number(parsed.get("--test-source-race-until") || 0);
  const busyMs = Number(parsed.get("--test-busy-ms") || 0);
  if (![sourceRaceUntil, busyMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000)) {
    fail("RECOVERY_CHILD_ARG_INVALID", "child test controls are out of bounds");
  }
  return { abrainHome: path.resolve(abrainHome), repoRoot: path.resolve(repoRoot), attempt, sourceRaceUntil, busyMs };
}

function emit(value, exitCode) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.busyMs > 0) {
    const until = performance.now() + options.busyMs;
    while (performance.now() < until) { /* test-only child CPU load */ }
  }
  if (options.attempt <= options.sourceRaceUntil) {
    fail("SOURCE_RACE", `test-injected source race on attempt ${options.attempt}`);
  }
  const require = createRequire(import.meta.url);
  const { createJiti } = require("jiti");
  const jiti = createJiti(options.repoRoot, { interopDefault: true });
  const publisher = jiti(path.join(options.repoRoot, "extensions/_shared/proposition-policy-stable-view-publisher.ts"));
  const publication = await publisher.publishPropositionPolicyStableView({
    mode: "production",
    sourceAbrainHome: options.abrainHome,
    repoRoot: options.repoRoot,
  });
  emit({
    schema_version: CHILD_SCHEMA,
    ok: true,
    publication_status: publication.status,
    bundle_hash: publication.bundle_hash,
  }, 0);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code).slice(0, 128)
    : "RECOVERY_CHILD_FAILED";
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
  emit({ schema_version: CHILD_SCHEMA, ok: false, error_code: code, error_message: message }, 1);
}
