#!/usr/bin/env node
/**
 * Formal CSJ production-derived clone rehearsal (spec §8.3).
 *
 * Runs the full production-derived clone matrix (eligibility + Cert.A–F + CAS +
 * T2 + next-boot history + remote FF + idempotent). Only when the matrix is
 * fully green may the default host receipt (0600) be written.
 *
 * Usage:
 *   node scripts/csj-rehearse-production.mjs --dry-run \
 *     --daemon-binary /path/to/candidate-daemon
 *   node scripts/csj-rehearse-production.mjs \
 *     --daemon-binary /path/to/candidate-daemon
 *
 * Receipt binds: candidate daemon binary path digest + real pi version +
 * current import closure + production initial fingerprints.
 *
 * Never performs live production CAS / commit / push / dispatch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });

const artifact = jiti(path.join(root, "extensions/_shared/csj-artifact-binding.ts"));
const l1 = jiti(path.join(root, "extensions/_shared/l1-schema-registry.ts"));
const scanCache = jiti(path.join(root, "extensions/_shared/l1-validated-scan-cache.ts"));
const runtimeMod = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));

const PRODUCTION = process.env.CSJ_PRODUCTION_ABRAIN || "/home/worker/.abrain";

function parseArgs(argv) {
  const out = {
    dryRun: false,
    daemonBinary: null,
    receiptHome: null,
    piCommand: "pi",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--daemon-binary") out.daemonBinary = argv[++i];
    else if (a === "--receipt-home") out.receiptHome = argv[++i];
    else if (a === "--pi-command") out.piCommand = argv[++i];
    else if (a === "--production") out.production = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  console.log(`Usage: node scripts/csj-rehearse-production.mjs [options]
  --dry-run                 Run full matrix; do not write host receipt
  --daemon-binary <path>    Candidate daemon binary (required for receipt / production binding)
  --receipt-home <dir>      Override default host receipt state home
  --pi-command <cmd>        pi executable for --version (default: pi)
  --production <path>       Production abrain root (default: /home/worker/.abrain)
  --help                    Show this help`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const production = path.resolve(args.production || PRODUCTION);
  assert(fs.existsSync(production), `production abrain missing: ${production}`);

  if (!args.daemonBinary && !args.dryRun) {
    throw new Error("writing receipt requires --daemon-binary <candidate path>");
  }
  if (!args.daemonBinary && args.dryRun) {
    console.warn("[csj-rehearse] --dry-run without --daemon-binary: matrix runs; receipt parts use injectable placeholder digest only for dry compute");
  }

  // Capture production fingerprints BEFORE any work (read-only).
  const beforeHead = git(production, "rev-parse", "HEAD");
  const bigGitOpts = {
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  };
  const beforeStatusHash = crypto.createHash("sha256").update(
    execFileSync("git", ["-C", production, "status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"], bigGitOpts),
  ).digest("hex");
  const beforeL1Count = execFileSync("git", ["-C", production, "ls-tree", "-r", "--name-only", "HEAD", "--", "l1/"], {
    encoding: "utf8",
    ...bigGitOpts,
  }).split("\n").filter(Boolean).length;

  console.log(`[csj-rehearse] production HEAD=${beforeHead}`);
  console.log(`[csj-rehearse] statusHash=${beforeStatusHash}`);
  console.log(`[csj-rehearse] L1 count=${beforeL1Count}`);
  console.log(`[csj-rehearse] dry-run=${args.dryRun}`);

  // Delegate the full named matrix to smoke-csj (includes production-derived cells).
  // Inherit env; force test hooks for injectable artifact cells inside smoke only.
  const smoke = path.join(root, "scripts/smoke-csj.mjs");
  console.log(`[csj-rehearse] running full CSJ matrix: ${smoke}`);
  const run = spawnSync(process.execPath, [smoke], {
    cwd: root,
    env: {
      ...process.env,
      PI_ASTACK_ENABLE_TEST_HOOKS: "1",
      CSJ_PRODUCTION_ABRAIN: production,
    },
    stdio: "inherit",
  });
  if (run.status !== 0) {
    throw new Error(`CSJ matrix failed (exit ${run.status}); refuse receipt write`);
  }
  console.log("[csj-rehearse] matrix green");

  // Re-verify production fingerprint unchanged.
  const afterHead = git(production, "rev-parse", "HEAD");
  const afterStatusHash = crypto.createHash("sha256").update(
    execFileSync("git", ["-C", production, "status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"], bigGitOpts),
  ).digest("hex");
  const afterL1Count = execFileSync("git", ["-C", production, "ls-tree", "-r", "--name-only", "HEAD", "--", "l1/"], {
    encoding: "utf8",
    ...bigGitOpts,
  }).split("\n").filter(Boolean).length;
  assert(afterHead === beforeHead, `production HEAD mutated during rehearse: ${beforeHead} → ${afterHead}`);
  assert(afterStatusHash === beforeStatusHash, "production status fingerprint mutated during rehearse");
  assert(afterL1Count === beforeL1Count, `production L1 count mutated: ${beforeL1Count}→${afterL1Count}`);

  // Live fingerprints for receipt.
  const registry = l1.loadL1SchemaRegistry();
  const registryHash = scanCache.registryContentHash(registry);
  const validatorFingerprint = scanCache.L1_VALIDATED_SCAN_VALIDATOR_FINGERPRINT
    || "l1-validated-scan-validator/v1";
  // Implementation fingerprint: provenance over CSJ closure roots when available.
  let implementationFingerprint;
  try {
    if (typeof runtimeMod.provenanceFingerprint === "function" && typeof runtimeMod.loadLoadedProvenance === "function") {
      implementationFingerprint = runtimeMod.provenanceFingerprint(runtimeMod.loadLoadedProvenance());
    }
  } catch { /* fall through */ }
  if (!implementationFingerprint) {
    // Stable digest over the CSJ module closure itself.
    const closure = artifact.buildCsjSedimentModuleClosure(root);
    implementationFingerprint = crypto.createHash("sha256")
      .update(closure.map((r) => `${r.relativePath}:${r.sha256}`).join("\n"))
      .digest("hex");
  }

  const partsOpts = {
    sourceRoot: root,
    piCommand: args.piCommand,
  };
  if (args.daemonBinary) {
    partsOpts.daemonBinaryPath = path.resolve(args.daemonBinary);
  } else {
    // Dry-run only placeholder — never written as production receipt authority.
    partsOpts.daemonBinarySha256 = "0".repeat(64);
  }
  const parts = await artifact.computeExecutionArtifactParts(partsOpts);
  const digest = artifact.computeExecutionArtifactDigestFromParts(parts);
  const receipt = artifact.buildCloneGreenReceipt({
    parts,
    executionArtifactDigest: digest,
    implementationFingerprint,
    validatorFingerprint,
    registryHash,
  });

  const receiptHome = args.receiptHome
    ? path.resolve(args.receiptHome)
    : artifact.defaultCsjReceiptStateHome();

  console.log(`[csj-rehearse] executionArtifactDigest=${digest}`);
  console.log(`[csj-rehearse] implementationFingerprint=${implementationFingerprint}`);
  console.log(`[csj-rehearse] validatorFingerprint=${validatorFingerprint}`);
  console.log(`[csj-rehearse] registryHash=${registryHash}`);
  console.log(`[csj-rehearse] daemon_binary_sha256=${parts.daemon_binary_sha256}`);
  console.log(`[csj-rehearse] pi_executable_version=${parts.pi_executable_version}`);
  console.log(`[csj-rehearse] sediment_module_closure entries=${parts.sediment_module_closure.length}`);
  console.log(`[csj-rehearse] receiptHome=${receiptHome}`);

  if (args.dryRun) {
    console.log("[csj-rehearse] --dry-run: matrix green; receipt NOT written");
    console.log(JSON.stringify({
      dry_run: true,
      matrix_status: "green",
      receipt_would_write_to: artifact.csjArtifactReceiptPath(receiptHome),
      executionArtifactDigest: digest,
      production_initial: {
        head: beforeHead,
        statusHash: beforeStatusHash,
        l1Count: beforeL1Count,
      },
      parts: {
        daemon_binary_sha256: parts.daemon_binary_sha256,
        pi_executable_version: parts.pi_executable_version,
        csj_spec_version: parts.csj_spec_version,
        sediment_module_closure_count: parts.sediment_module_closure.length,
      },
    }, null, 2));
    return;
  }

  if (!args.daemonBinary) {
    throw new Error("refusing receipt write without --daemon-binary");
  }
  const written = await artifact.writeCsjCloneGreenReceipt(receiptHome, receipt);
  try { fs.chmodSync(written, 0o600); } catch { /* best-effort */ }
  try { fs.chmodSync(path.dirname(written), 0o700); } catch { /* best-effort */ }
  console.log(`[csj-rehearse] wrote receipt 0600: ${written}`);
}

main().catch((error) => {
  console.error(`[csj-rehearse] FAIL: ${error?.stack || error}`);
  process.exit(1);
});
