#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

function readEvidence(relative, hashField) {
  const file = path.join(repoRoot, relative);
  const raw = fs.readFileSync(file, "utf8");
  const value = JSON.parse(raw);
  if (`${canonicalizeJcs(value)}\n` !== raw) throw new Error(`${relative} is not exact JCS+LF`);
  const base = { ...value }; delete base[hashField];
  if (value[hashField] !== jcsSha256Hex(base)) throw new Error(`${relative} self-hash differs`);
  return { file, raw, value };
}

function loadFrozen() {
  const manifestEvidence = readEvidence(r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE, "manifest_hash");
  const liveManifest = r4.buildD3V2R4OperatorManifest(repoRoot);
  r4.validateD3V2R4OperatorManifest(manifestEvidence.value);
  if (canonicalizeJcs(liveManifest) !== canonicalizeJcs(manifestEvidence.value)) throw new Error("live R4 source closure differs from operator manifest");
  const dossierEvidence = readEvidence(r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, "dossier_hash");
  const d = dossierEvidence.value;
  return {
    schema_version: "adr0040-d3-v2-session-start-r4-frozen-execution-binding/v1",
    session_id: d.target_session.session_id,
    sessions_root: d.target_session.sessions_root,
    session_file: d.target_session.session_file,
    settings_path: d.settings.path,
    settings_pre: d.settings.pre_identity,
    settings_post_raw_sha256: d.settings.post_raw_sha256,
    desired_settings: d.settings.desired_v2_subtree,
    control_root: d.control_paths.control_root,
    old_activation_root: d.control_paths.old_activation_root,
    runtime_audit_path: d.control_paths.runtime_audit_path,
    operator_audit_path: d.control_paths.operator_audit_path,
    rollback_target: d.control_paths.rollback_target,
    quarantine_target: d.control_paths.quarantine_target,
    d3_identities: d.d3_identities,
    adapter_manifest_hash: d.adapter_manifest.manifest_hash,
    operator_manifest: {
      relative_path: r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE,
      raw_sha256: sha256Hex(manifestEvidence.raw),
      manifest_hash: manifestEvidence.value.manifest_hash,
      graph_hash: manifestEvidence.value.graph.graph_hash,
      source_closure_hash: manifestEvidence.value.source_closure_hash,
    },
    predecessor_dossier: d.predecessor_dossier,
    execution_dossier: { relative_path: r4.D3_V2_R4_EXECUTION_DOSSIER_RELATIVE, raw_sha256: sha256Hex(dossierEvidence.raw), self_hash: d.dossier_hash },
    source_commit: null,
    source_commit_required_at_production_authorization: true,
  };
}

function sourceState() {
  const status = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1"], { encoding: "utf8" });
  const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  return { clean: status.status === 0 && status.stdout === "", commit: rev.status === 0 ? rev.stdout.trim() : null };
}

function preview() {
  const protectedPaths = [
    r4.D3_V2_R4_PRODUCTION_SESSION_PATH,
    r4.D3_V2_R4_PRODUCTION_SETTINGS_PATH,
    core.D3_PUB_HARD_ROOT,
    r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT,
    r4.D3_V2_R4_PRODUCTION_OLD_ACTIVATION_ROOT,
  ];
  const before = core.captureProtectedPrestate(protectedPaths);
  const frozen = loadFrozen();
  const source = sourceState();
  const after = core.captureProtectedPrestate(protectedPaths);
  if (canonicalizeJcs(before) !== canonicalizeJcs(after)) throw new Error("protected production snapshot drifted during read-only preview");
  return {
    schema_version: "adr0040-d3-v2-session-start-r4-live-read-only-preview/v1",
    mode: "production_read_only_preview",
    revision: "R4",
    authorization_status: "NOT_AUTHORIZED",
    executable: false,
    bind_existing_only: true,
    target_session: frozen.session_file,
    settings_pre_raw_sha256: frozen.settings_pre.raw_sha256,
    settings_post_raw_sha256: frozen.settings_post_raw_sha256,
    operator_manifest_hash: frozen.operator_manifest.manifest_hash,
    execution_dossier_hash: frozen.execution_dossier.self_hash,
    source_commit_preview: source,
    authorization_phrase_sha256: sha256Hex(r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE),
    continue_phrase_sha256: sha256Hex(r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE),
    protected_snapshot_equal: true,
    production_write_invoked: false,
    session_write_invoked: false,
    rollback_invoked: false,
  };
}

const argv = process.argv.slice(2);
const forbidden = ["--force", "--yes", "--target", "--settings", "--session", "--authorization", "--authorization-json", "--authorization-text", "--receipt", "--intent"].find((flag) => argv.includes(flag));
if (forbidden) throw new Error(`caller-supplied authority/path option forbidden: ${forbidden}`);
if (argv.length === 0) process.stdout.write(`${canonicalizeJcs(preview())}\n`);
else if (argv.length === 1 && argv[0] === "--execute") process.stdout.write(`${canonicalizeJcs(r4.executeD3V2R4BindOperator({ target: "production", mode: "execute", frozen: loadFrozen() }))}\n`);
else if (argv.length === 1 && argv[0] === "--continue") process.stdout.write(`${canonicalizeJcs(r4.executeD3V2R4BindOperator({ target: "production", mode: "continue", frozen: loadFrozen() }))}\n`);
else throw new Error("usage: operator [--execute|--continue]; default is read-only preview");
