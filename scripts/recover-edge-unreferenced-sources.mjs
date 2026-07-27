#!/usr/bin/env node
/**
 * Operator: recover journal-unreferenced edge-protocol-shadow sources.
 *
 * Default dry-run (no writes). Pass `--execute` to write candidate+witness under
 * the session journal OFD lock with monotonic producer_seq. Never creates
 * semantic jobs / ACK / mutates source bytes. Never auto-runs on session_start.
 *
 * Usage:
 *   node scripts/recover-edge-unreferenced-sources.mjs --abrain-home <path> [--owner-project-root <path>] [--session-id <id>] [--limit N] [--execute]
 *
 * Output: single JSON object (no raw message bodies / absolute source paths).
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true, moduleCache: false });

function fail(code, message) {
  process.stderr.write(JSON.stringify({ ok: false, error_code: code, error_detail: message }) + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  let abrainHome;
  let ownerProjectRoot;
  let sessionId;
  let limit;
  let execute = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--abrain-home") {
      if (abrainHome !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--abrain-home requires one value");
      abrainHome = argv[++i];
    } else if (a === "--owner-project-root") {
      if (ownerProjectRoot !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--owner-project-root requires one value");
      ownerProjectRoot = argv[++i];
    } else if (a === "--session-id") {
      if (sessionId !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--session-id requires one value");
      sessionId = argv[++i];
    } else if (a === "--limit") {
      if (limit !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--limit requires one value");
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) fail("ARGUMENT_INVALID", "--limit must be positive integer");
      limit = n;
    } else if (a === "--execute") {
      if (execute) fail("ARGUMENT_INVALID", "--execute may appear only once");
      execute = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "recover-edge-unreferenced-sources.mjs --abrain-home <path> [--owner-project-root <path>] [--session-id <id>] [--limit N] [--execute]\n",
      );
      process.exit(0);
    } else {
      fail("ARGUMENT_INVALID", `unknown argument: ${a}`);
    }
  }
  if (!abrainHome) fail("ARGUMENT_INVALID", "--abrain-home is required");
  return {
    abrainHome: path.resolve(abrainHome),
    ...(ownerProjectRoot ? { ownerProjectRoot: path.resolve(ownerProjectRoot) } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    execute,
  };
}

const args = parseArgs(process.argv.slice(2));
const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
const result = await edge.recoverEdgeProtocolUnreferencedSources(args);
// Low-cardinality audit summary; item content_id only as prefix.
const out = {
  ok: result.status === "ready",
  status: result.status,
  mode: result.mode,
  duration_ms: Math.round(result.duration_ms * 1000) / 1000,
  scanned: result.scanned,
  eligible: result.eligible,
  recovered: result.recovered,
  reused: result.reused,
  failed: result.failed,
  skipped: result.skipped,
  already_referenced: result.already_referenced,
  sessions_scanned: result.sessions_scanned,
  items: result.items,
  ...(result.error_code ? { error_code: result.error_code } : {}),
  ...(result.error_detail ? { error_detail: result.error_detail } : {}),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(result.status === "ready" && result.failed === 0 ? 0 : 1);
