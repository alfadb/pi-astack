#!/usr/bin/env node
/** ADR0040 P0b.1 sandbox-only production genesis dossier. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-genesis-writer.ts"));
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));
const prop = jiti(path.join(repoRoot, "extensions/_shared/proposition.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

function arg(name, def = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(code, message, detail = {}) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.detail = detail;
  throw err;
}

function assertCliSandboxAbrainHome(value) {
  if (!value || !value.trim()) fail("PROPOSITION_GENESIS_SANDBOX_REQUIRED", "--abrain must be an explicit sandbox path");
  const resolved = path.resolve(value);
  const realCandidates = [path.resolve("/home/worker/.abrain"), path.resolve(os.homedir(), ".abrain")];
  if (realCandidates.includes(resolved)) fail("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", "P0b.1 CLI refuses the real abrain home", { path: resolved });
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const rel = path.relative(tmpRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("PROPOSITION_GENESIS_SANDBOX_REQUIRED", `--abrain must point inside ${tmpRoot}`, { path: resolved });
  }
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) fail("PROPOSITION_GENESIS_SYMLINK_REJECTED", "--abrain must not be a symlink", { path: resolved });
    if (!stat.isDirectory()) fail("PROPOSITION_GENESIS_NON_REGULAR", "--abrain must be a directory when it already exists", { path: resolved });
    const real = fs.realpathSync(resolved);
    if (realCandidates.map((item) => fs.existsSync(item) ? fs.realpathSync(item) : item).includes(real)) {
      fail("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", "P0b.1 CLI refuses real abrain realpath", { path: resolved, realpath: real });
    }
  }
  return resolved;
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileHashMap(root) {
  return Object.fromEntries(listFiles(root).map((rel) => [rel, fileHash(path.join(root, rel))]));
}

function diffInventory(before, after) {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const created = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort();
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort();
  const modified = [...afterKeys].filter((key) => beforeKeys.has(key) && before[key] !== after[key]).sort();
  return { created, removed, modified };
}

function mutationClasses(paths) {
  return {
    l1_events: paths.filter((rel) => rel.startsWith("l1/events/sha256/")),
    l2: paths.filter((rel) => rel.startsWith("l2/")),
    state: paths.filter((rel) => rel.startsWith(".state/")),
    legacy_or_other: paths.filter((rel) => !rel.startsWith("l1/events/sha256/") && !rel.startsWith("l2/") && !rel.startsWith(".state/")),
  };
}

async function expectCode(fn) {
  try {
    await fn();
    return { code: null, ok: false };
  } catch (err) {
    return { code: err?.code || "ERROR", ok: true, message: err?.message || String(err) };
  }
}

function selfHashDossier(dossier) {
  const clone = JSON.parse(JSON.stringify(dossier));
  delete clone.dossier_hash;
  return jcs.jcsSha256Hex(clone);
}

async function main() {
  const abrainHome = assertCliSandboxAbrainHome(arg("abrain"));
  const registryPath = path.resolve(arg("registry", path.join(repoRoot, "schemas/l1-schema-role-registry.json")));
  const sandboxExistedBefore = fs.existsSync(abrainHome);
  const beforeHashMap = fileHashMap(abrainHome);
  const beforeFiles = Object.keys(beforeHashMap).sort();

  const first = await writer.writeProductionPropositionGenesis({ sandboxAbrainHome: abrainHome, registryPath });
  const afterFirstHashMap = fileHashMap(abrainHome);
  const second = await writer.writeProductionPropositionGenesis({ sandboxAbrainHome: abrainHome, registryPath });
  const afterSecondHashMap = fileHashMap(abrainHome);
  const reader = await writer.readProductionPropositionGenesisEvent({ sandboxAbrainHome: abrainHome, eventId: first.tuple.event_id, registryPath });

  const genericGate = await expectCode(() => l1.validateL1WritePreflight({
    abrainHome,
    envelope: first.tuple.envelope,
    targetPath: first.tuple.target_path,
    registryPath,
    expected: {
      envelopeSchema: prop.PROPOSITION_GENESIS_ENVELOPE_SCHEMA,
      domain: "proposition",
      role: "meta",
      producer: prop.PROPOSITION_PRODUCTION_GENESIS_PRODUCER,
      eventType: "proposition_genesis_declared",
    },
  }));

  const firstDiff = diffInventory(beforeHashMap, afterFirstHashMap);
  const secondDiff = diffInventory(afterFirstHashMap, afterSecondHashMap);
  const createdClasses = mutationClasses(firstDiff.created);
  const secondClasses = mutationClasses([...secondDiff.created, ...secondDiff.modified, ...secondDiff.removed]);
  const dossier = {
    schema_version: "proposition-p0b1-sandbox-dossier/v1",
    dossier_canonicalization: "RFC8785-JCS",
    dossier_hash_algorithm: "sha256",
    dossier_hash_scope: "sha256 over RFC8785-JCS UTF-8 bytes of this dossier object with dossier_hash omitted",
    dossier_hash: "",
    generated_at_utc: new Date().toISOString(),
    repo_root: repoRoot,
    sandbox: {
      abrain_home: first.tuple.sandbox_abrain_home,
      realpath: first.tuple.sandbox_abrain_realpath,
      existed_before: sandboxExistedBefore,
    },
    registry: {
      path: first.tuple.registry_path,
      registry_id: first.tuple.registry_id,
      registry_canonical_sha256: first.tuple.registry_canonical_sha256,
      registry_file_sha256: first.tuple.registry_file_sha256,
    },
    proposition_schema_contract: {
      schema_version: prop.PROPOSITION_SCHEMA_CONTRACT_SCHEMA,
      schema_contract_hash: first.tuple.proposition_schema_contract_hash,
      binding_manifest_hash: first.tuple.binding_manifest_hash,
      binding_manifest_hash_algorithm: "sha256",
      binding_manifest_canonicalization: "RFC8785-JCS",
    },
    genesis: {
      epoch_id: first.tuple.epoch_id,
      epoch_anchor_convention: "production genesis body omits genesis_event_id to avoid a self-reference loop; the epoch anchor is the content-addressed genesis event_id, and future proposition events must bind epoch.genesis_event_id to this value with the same epoch_id",
      event_id: first.tuple.event_id,
      body_hash: first.tuple.envelope.body_hash,
      envelope_hash: l1.canonicalL1EnvelopeHash(first.tuple.envelope),
      relative_path: first.tuple.relative_path,
      target_path: first.tuple.target_path,
      first_write_status: first.status,
      idempotent_rerun_status: second.status,
      reader_byte_identical: reader.byte_identical,
      reader_raw_sha256: fileHash(first.tuple.target_path),
    },
    before: {
      files: beforeFiles,
      scan: first.before,
    },
    after: {
      files: Object.keys(afterFirstHashMap).sort(),
      scan: first.after,
      acceptance_counts: {
        exactly_one_defined_inactive_genesis: first.after.propositionGenesis === 1 && first.after.productionGenesis === 1 && first.after.definedInactiveShadow === 1,
        selected_zero: first.after.selected === 0 && first.after.propositionSelected === 0,
        foldable_zero: first.after.foldable === 0 && first.after.propositionFoldable === 0,
        evidence_zero: first.after.propositionEvidence === 0,
        lifecycle_zero: first.after.propositionLifecycle === 0,
        projection_zero: first.after.propositionProjection === 0,
      },
    },
    mutation_inventory: {
      first_write: {
        ...firstDiff,
        classes: createdClasses,
      },
      idempotent_rerun: {
        ...secondDiff,
        classes: secondClasses,
      },
      no_l2_state_or_legacy_mutation: createdClasses.l2.length === 0
        && createdClasses.state.length === 0
        && createdClasses.legacy_or_other.length === 0
        && secondClasses.l2.length === 0
        && secondClasses.state.length === 0
        && secondClasses.legacy_or_other.length === 0,
    },
    write_gates: {
      generic_validateL1WritePreflight: genericGate,
      specialized_writer_statuses: [first.status, second.status],
    },
  };
  dossier.dossier_hash = selfHashDossier(dossier);

  const out = arg("out");
  if (out) {
    const outPath = path.resolve(out);
    const realAbrain = path.resolve("/home/worker/.abrain");
    if (outPath === realAbrain || outPath.startsWith(`${realAbrain}${path.sep}`)) {
      fail("PROPOSITION_GENESIS_REAL_ABRAIN_REJECTED", "--out must not target the real abrain home", { outPath });
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(dossier, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(dossier, null, hasFlag("compact") ? 0 : 2)}\n`);
}

main().catch((err) => {
  const code = err?.code || "PROPOSITION_P0B1_DOSSIER_FAILED";
  process.stderr.write(`${code}: ${err?.message || String(err)}\n`);
  if (err?.detail) process.stderr.write(`${JSON.stringify(err.detail)}\n`);
  process.exitCode = 1;
});
