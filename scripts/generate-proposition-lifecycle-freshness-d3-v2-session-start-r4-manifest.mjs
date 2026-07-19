#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const { canonicalizeJcs } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const args = process.argv.slice(2);
const write = args[0] === "--write";
const verify = args[0] === "--verify";
if (args.length > 1 || (args.length === 1 && !write && !verify)) throw new Error("usage: generator [--write|--verify]");
const target = path.join(repoRoot, r4.D3_V2_R4_OPERATOR_MANIFEST_RELATIVE);
const manifest = r4.buildD3V2R4OperatorManifest(repoRoot);
r4.validateD3V2R4OperatorManifest(manifest);
const raw = `${canonicalizeJcs(manifest)}\n`;
if (write) {
  fs.writeFileSync(target, raw, { encoding: "utf8", flag: "w", mode: 0o644 });
  process.stdout.write(JSON.stringify({ written: target, manifest_hash: manifest.manifest_hash, source_closure_hash: manifest.source_closure_hash }) + "\n");
} else if (verify) {
  const existing = fs.readFileSync(target, "utf8");
  r4.validateD3V2R4OperatorManifest(JSON.parse(existing));
  if (existing !== raw) throw new Error("R4 operator manifest bytes differ from rebuilt closure");
  process.stdout.write(JSON.stringify({ verified: true, manifest_hash: manifest.manifest_hash, source_closure_hash: manifest.source_closure_hash }) + "\n");
} else process.stdout.write(raw);
