#!/usr/bin/env node
/** ADR0040 Stage2 real-production preview with an owned disposable ZFS sandbox lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sandboxRoot = "/home/worker/.adr0040-stage2-sandbox-019f569c";
const ZFS_MAGIC = 0x2fc12fc1;
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-production-preview.ts"));

async function main() {
  if (process.argv.length !== 2) throw new preview.RealPolicyAppendPreviewError("REAL_POLICY_APPEND_ARGUMENT", "Stage2 production preview accepts no arguments or bypasses");
  prepareSandbox();
  try {
    const outputPath = path.join(repoRoot, preview.REAL_POLICY_APPEND_PREVIEW_RELATIVE);
    const result = await preview.writeRealPolicyAppendProductionPreview({ repoRoot, abrainHome: preview.REAL_POLICY_APPEND_HARD_ABRAIN, sandboxRoot, outputPath });
    return {
      verdict: "PASS_EXECUTION_READY_READ_ONLY",
      dossier_path: outputPath,
      dossier_bytes: result.bytes,
      dossier_raw_sha256: result.raw_sha256,
      dossier_hash: result.dossier.dossier_hash,
      source_closure_hash: result.dossier.source_closure.closure_hash,
      execution_closure_hash: result.dossier.platform_closure.closure_hash,
      whole_abrain_ambient_drift_observed: result.dossier.production_mutation_proof.whole_abrain_evidence_only.ambient_drift_observed,
      whole_abrain_delta_count: result.dossier.production_mutation_proof.whole_abrain_evidence_only.delta_count,
      hard_anchor_hash: result.dossier.hard_anchor_observations.C1_hash,
      production_repo_existing_paths_unchanged: result.dossier.production_mutation_proof.repo_existing_paths_excluding_exact_stage2_leaves.equal,
      target_absent: result.dossier.target_observation.after.target_state === "absent",
      stage3_authorized: false,
      stage3_authorization_text_generated: false,
      stage3_outputs_absent: result.dossier.stage3_boundary.outputs_absent,
      sandbox_cleaned_on_exit: true,
    };
  } finally { cleanupSandbox(); }
}

function prepareSandbox() {
  assertSandboxLiteral();
  if (lstatMaybe(sandboxRoot)) {
    assertOwnedDirectory(sandboxRoot);
    assertNoNestedMounts();
    fs.rmSync(sandboxRoot, { recursive: true, force: false });
  }
  if (lstatMaybe(sandboxRoot)) throw new Error("sandbox cleanup did not make the root absent");
  fs.mkdirSync(sandboxRoot, { mode: 0o700 });
  fs.chmodSync(sandboxRoot, 0o700);
  assertOwnedDirectory(sandboxRoot);
  if (Number(fs.statfsSync(sandboxRoot).type) !== ZFS_MAGIC) throw new Error("sandbox root is not on the required real ZFS filesystem");
}

function cleanupSandbox() {
  assertSandboxLiteral();
  if (!lstatMaybe(sandboxRoot)) return;
  assertOwnedDirectory(sandboxRoot);
  assertNoNestedMounts();
  fs.rmSync(sandboxRoot, { recursive: true, force: false });
  if (lstatMaybe(sandboxRoot)) throw new Error("sandbox root remained after cleanup");
}

function assertSandboxLiteral() {
  if (sandboxRoot !== "/home/worker/.adr0040-stage2-sandbox-019f569c" || path.dirname(sandboxRoot) !== "/home/worker") throw new Error("sandbox literal escaped the single authorized ZFS root");
}
function assertOwnedDirectory(directory) { const stat = fs.lstatSync(directory); const uid = process.getuid?.() ?? stat.uid; const gid = process.getgid?.() ?? stat.gid; if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || fs.realpathSync.native(directory) !== directory) throw new Error("sandbox root is not the exact runner-owned directory"); }
function assertNoNestedMounts() { const prefix = `${sandboxRoot}/`; const nested = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) => line.split(" ")[4]).filter((mountpoint) => mountpoint === sandboxRoot || mountpoint?.startsWith(prefix)); if (nested.length) throw new Error(`sandbox contains a mountpoint: ${nested.join(",")}`); }
function lstatMaybe(file) { try { return fs.lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`${error?.code ?? "REAL_POLICY_APPEND_PREVIEW_FAILED"}: ${error?.message ?? String(error)}\n`);
  if (error?.detail) process.stderr.write(`${JSON.stringify(error.detail)}\n`);
  process.exitCode = 1;
});
