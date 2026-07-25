#!/usr/bin/env node
/**
 * External read-only adapter CLI for pi-router Stage A0 cross-repo conformance.
 *
 * Contract (fail-closed):
 *   argv: --pi-router-root <absolute>   (required; no PI_ROUTER_ROOT env main path)
 *   env (only five injected by harness after env_clear):
 *     PI_MEMORY_EDGE_SHADOW_ROOT
 *     PI_MEMORY_EDGE_ADAPTER_OUTPUT_DIR
 *     PI_MEMORY_CONTRACT_COMMIT
 *     PI_MEMORY_FDS_SHA256
 *     PI_MEMORY_PROTO_JSON_FIELD_NAMES
 *
 * Writes ONLY under OUTPUT_DIR:
 *   manifest.json  — pi-router/edge-shadow-adapter-conformance/v1
 *   records.ndjson — one formal EdgeShadowJournalRecord proto JSON per line
 *
 * Never prints body / absolute path / digests to stdout or stderr.
 * Exit 0 only when bundle is complete; any projection/scan failure → non-zero.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const MANIFEST_SCHEMA = "pi-router/edge-shadow-adapter-conformance/v1";
const SOURCE_SCHEMA = "pi-astack/edge-journal/v1";
const FORMAL_MESSAGE = "pi.memory.v1.EdgeShadowJournalRecord";
const PROTO_JSON_FIELD_NAMES = "preserving_proto_field_name";
const MUTATION_MODE = "read_only_projection";
const RECORDS_FILE = "records.ndjson";
const MANIFEST_FILE = "manifest.json";

function exitFail() {
  // No body/path/detail on any stream.
  process.exit(2);
}

async function main() {
  const edgeRootRaw = process.env.PI_MEMORY_EDGE_SHADOW_ROOT;
  const outDirRaw = process.env.PI_MEMORY_EDGE_ADAPTER_OUTPUT_DIR;
  const commitEnv = process.env.PI_MEMORY_CONTRACT_COMMIT;
  const fdsEnv = process.env.PI_MEMORY_FDS_SHA256;
  const fieldNamesEnv = process.env.PI_MEMORY_PROTO_JSON_FIELD_NAMES;

  if (!edgeRootRaw || !outDirRaw || !commitEnv || !fdsEnv || !fieldNamesEnv) {
    exitFail();
  }

  // fsCache:false — success path must not write jiti cache outside harness output dir.
  const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
  const adapter = await jiti.import(
    path.join(root, "extensions/sediment/edge-shadow-frozen-contract-adapter.ts"),
  );

  if (commitEnv !== adapter.FROZEN_MEMORY_CONTRACT_COMMIT) exitFail();
  if (fdsEnv !== adapter.FROZEN_MEMORY_FDS_SHA256) exitFail();
  if (fieldNamesEnv !== PROTO_JSON_FIELD_NAMES) exitFail();

  // H2: pi-router root via strict argv only (harness env_clear drops PI_ROUTER_ROOT).
  let piRouterRoot;
  try {
    piRouterRoot = adapter.parsePiRouterRootArgv(process.argv.slice(2));
  } catch {
    exitFail();
  }

  // Fail-closed identity: exact freeze commit object + FDS digest.
  try {
    const identity = adapter.verifyFrozenContractIdentity({
      piRouterRoot,
      require: true,
      checkGitHead: true,
    });
    if (identity.fds_status !== "verified") exitFail();
    if (identity.pi_router_head_matches_contract !== true) exitFail();
    adapter.loadFrozenEdgeShadowContract({ piRouterRoot });
  } catch {
    exitFail();
  }

  let edgeRoot;
  let outDir;
  try {
    edgeRoot = path.resolve(edgeRootRaw);
    outDir = path.resolve(outDirRaw);
    const edgeSt = fs.lstatSync(edgeRoot);
    const outSt = fs.lstatSync(outDir);
    if (edgeSt.isSymbolicLink() || !edgeSt.isDirectory()) exitFail();
    if (outSt.isSymbolicLink() || !outSt.isDirectory()) exitFail();
  } catch {
    exitFail();
  }

  // Ensure output dir is empty of unexpected content before write.
  let existing;
  try {
    existing = fs.readdirSync(outDir);
  } catch {
    exitFail();
  }
  if (existing.length > 0) {
    // Harness temp dir should be empty; refuse to clobber unknown files.
    exitFail();
  }

  let aggregate;
  let projections;
  try {
    ({ aggregate, projections } = adapter.scanEdgeShadowRootReadOnly(edgeRoot, {
      piRouterRoot,
    }));
  } catch {
    exitFail();
  }

  const failClosed =
    aggregate.records_projection_failed > 0 ||
    aggregate.filename_seq_mismatch > 0 ||
    aggregate.filename_record_id_mismatch > 0 ||
    aggregate.rejected_unexpected_record > 0 ||
    aggregate.scan_errors > 0 ||
    aggregate.raw_sidecar_missing_file > 0 ||
    aggregate.raw_sidecar_content_id_mismatch > 0 ||
    aggregate.raw_sidecar_byte_length_mismatch > 0 ||
    aggregate.raw_sidecar_messages_digest_mismatch > 0 ||
    aggregate.raw_sidecar_schema_mismatch > 0 ||
    projections.length !== aggregate.records_projected_ok ||
    aggregate.records_projected_ok !== aggregate.records_seen ||
    projections.some(
      (p) =>
        !p.proto_json ||
        typeof p.identity?.record_id !== "string" ||
        !(p.wire instanceof Uint8Array) ||
        p.wire.byteLength === 0,
    );

  if (failClosed) exitFail();

  // Write records.ndjson — formal proto JSON only (preserving_proto_field_name).
  const recordsPath = path.join(outDir, RECORDS_FILE);
  try {
    const fd = fs.openSync(recordsPath, "w", 0o600);
    try {
      for (const p of projections) {
        const line = `${JSON.stringify(p.proto_json)}\n`;
        fs.writeSync(fd, line, null, "utf8");
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    exitFail();
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    contract_commit: adapter.FROZEN_MEMORY_CONTRACT_COMMIT,
    memory_fds_sha256: adapter.FROZEN_MEMORY_FDS_SHA256,
    source_schema: SOURCE_SCHEMA,
    formal_message: FORMAL_MESSAGE,
    proto_json_field_names: PROTO_JSON_FIELD_NAMES,
    mutation_mode: MUTATION_MODE,
    records_file: RECORDS_FILE,
    record_count: projections.length,
  };

  try {
    fs.writeFileSync(
      path.join(outDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    exitFail();
  }

  // Success: silent (harness discards streams).
  process.exit(0);
}

main().catch(() => exitFail());
