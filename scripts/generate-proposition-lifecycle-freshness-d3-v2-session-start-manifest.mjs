#!/usr/bin/env node
/**
 * Generate or verify the ADR0040 D3-v2 session_start adapter static dependency closure manifest.
 *
 * Usage:
 *   node scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-manifest.mjs
 *   node scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-manifest.mjs --verify path/to/manifest.json
 *   node scripts/generate-proposition-lifecycle-freshness-d3-v2-session-start-manifest.mjs --write path/to/manifest.json
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const adapter = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts"));
const { canonicalizeJcs } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const args = process.argv.slice(2);
const writeIdx = args.indexOf("--write");
const verifyIdx = args.indexOf("--verify");
const writePath = writeIdx >= 0 ? args[writeIdx + 1] : null;
const verifyPath = verifyIdx >= 0 ? args[verifyIdx + 1] : null;

const manifest = adapter.buildD3V2SessionStartAdapterManifest({ repoRoot });
adapter.validateD3V2SessionStartAdapterManifest(manifest);
const raw = `${canonicalizeJcs(manifest)}\n`;

if (verifyPath) {
  const existingRaw = fs.readFileSync(path.resolve(verifyPath), "utf8");
  const existing = JSON.parse(existingRaw);
  adapter.validateD3V2SessionStartAdapterManifest(existing);
  if (canonicalizeJcs(existing) !== canonicalizeJcs(manifest) || existingRaw !== raw) {
    process.stderr.write("manifest verification failed: bytes or hash drifted\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`manifest verified: manifest_hash=${manifest.manifest_hash} graph_hash=${manifest.graph.graph_hash}\n`);
  }
} else if (writePath) {
  const target = path.resolve(writePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw, "utf8");
  process.stdout.write(`manifest written: ${target}\nmanifest_hash=${manifest.manifest_hash}\ngraph_hash=${manifest.graph.graph_hash}\n`);
} else {
  process.stdout.write(raw);
}
