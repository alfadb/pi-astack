#!/usr/bin/env node
/**
 * Operator: recover journal-unreferenced edge-protocol-shadow sources.
 *
 * Default dry-run (no writes). Pass `--execute` to write candidate+witness under
 * the session journal OFD lock with monotonic producer_seq. Never creates
 * semantic jobs / ACK / mutates source bytes. Never auto-runs on session_start.
 *
 * Identity: never synthesizes C6/leaf. Leaf from source terminal assistant or
 * unique production capture audit; C6 only from unique capture-audit match.
 *
 * Usage:
 *   node scripts/recover-edge-unreferenced-sources.mjs \\
 *     --abrain-home <path> \\
 *     [--owner-project-root <path>] \\
 *     [--session-id <id> | --all-sessions] \\
 *     [--limit N] \\
 *     [--capture-audit-path <path>] \\
 *     [--operator-audit-path <path>] \\
 *     [--execute]
 *
 * execute requires: --owner-project-root, --session-id|--all-sessions,
 * --limit (1..100, eligible-only), --capture-audit-path, --operator-audit-path.
 *
 * Output: single JSON object (no raw session/path/digest; hashes/record prefixes only).
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
  let allSessions = false;
  let limit;
  let execute = false;
  let captureAuditPath;
  let operatorAuditPath;
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
    } else if (a === "--all-sessions") {
      if (allSessions) fail("ARGUMENT_INVALID", "--all-sessions may appear only once");
      allSessions = true;
    } else if (a === "--limit") {
      if (limit !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--limit requires one value");
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 100) fail("ARGUMENT_INVALID", "--limit must be integer 1..100");
      limit = n;
    } else if (a === "--capture-audit-path") {
      if (captureAuditPath !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--capture-audit-path requires one value");
      captureAuditPath = argv[++i];
    } else if (a === "--operator-audit-path") {
      if (operatorAuditPath !== undefined || i + 1 >= argv.length) fail("ARGUMENT_INVALID", "--operator-audit-path requires one value");
      operatorAuditPath = argv[++i];
    } else if (a === "--execute") {
      if (execute) fail("ARGUMENT_INVALID", "--execute may appear only once");
      execute = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "recover-edge-unreferenced-sources.mjs --abrain-home <path> [--owner-project-root <path>] [--session-id <id>|--all-sessions] [--limit N] [--capture-audit-path <path>] [--operator-audit-path <path>] [--execute]\n",
      );
      process.exit(0);
    } else {
      fail("ARGUMENT_INVALID", `unknown argument: ${a}`);
    }
  }
  if (!abrainHome) fail("ARGUMENT_INVALID", "--abrain-home is required");
  if (sessionId && allSessions) fail("ARGUMENT_INVALID", "--session-id and --all-sessions are mutually exclusive");
  if (execute) {
    if (!ownerProjectRoot) fail("ARGUMENT_INVALID", "execute requires --owner-project-root");
    if (!sessionId && !allSessions) fail("ARGUMENT_INVALID", "execute requires --session-id or --all-sessions");
    if (limit === undefined) fail("ARGUMENT_INVALID", "execute requires --limit (1..100)");
    if (!captureAuditPath) fail("ARGUMENT_INVALID", "execute requires --capture-audit-path");
    if (!operatorAuditPath) fail("ARGUMENT_INVALID", "execute requires --operator-audit-path");
  }
  return {
    abrainHome: path.resolve(abrainHome),
    ...(ownerProjectRoot ? { ownerProjectRoot: path.resolve(ownerProjectRoot) } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(allSessions ? { allSessions: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(captureAuditPath ? { captureAuditPath: path.resolve(captureAuditPath) } : {}),
    ...(operatorAuditPath ? { operatorAuditPath: path.resolve(operatorAuditPath) } : {}),
    execute,
  };
}

const args = parseArgs(process.argv.slice(2));
const edge = await jiti.import(path.join(root, "extensions/sediment/edge-protocol-shadow.ts"));
const result = await edge.recoverEdgeProtocolUnreferencedSources(args);
// Low-cardinality audit summary; no raw session/path/digest.
const out = {
  ok: result.status === "ready",
  status: result.status,
  mode: result.mode,
  duration_ms: Math.round(result.duration_ms * 1000) / 1000,
  scanned: result.scanned,
  eligible: result.eligible,
  recoverable: result.recoverable,
  nonrecoverable: result.nonrecoverable,
  rejected: result.rejected,
  recovered: result.recovered,
  reused: result.reused,
  failed: result.failed,
  skipped: result.skipped,
  already_referenced: result.already_referenced,
  sessions_scanned: result.sessions_scanned,
  ...(result.operator_audit_path_hash_prefix
    ? { operator_audit_path_hash_prefix: result.operator_audit_path_hash_prefix }
    : {}),
  items: result.items,
  ...(result.error_code ? { error_code: result.error_code } : {}),
  ...(result.error_detail ? { error_detail: result.error_detail } : {}),
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(result.status === "ready" && result.failed === 0 ? 0 : 1);
