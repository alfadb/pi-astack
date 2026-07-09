#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(repoRoot, "docs");

const explicitDocs = [path.join(docsRoot, "current-state.md")];
const architectureDir = path.join(docsRoot, "architecture");
const architectureDocs = (await fs.readdir(architectureDir))
  .filter((name) => name.endsWith(".md"))
  .map((name) => path.join(architectureDir, name));

const docs = [...explicitDocs, ...architectureDocs];
const referencePattern = /`(extensions\/[A-Za-z0-9_./*-]+\.ts)`/g;
const globAllowlist = new Set([
  "extensions/sediment/constraint-evidence/*.ts",
]);

async function literalExists(ref) {
  try {
    const stat = await fs.stat(path.join(repoRoot, ref));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function globHasMatch(ref) {
  if (!globAllowlist.has(ref)) return false;
  const starIndex = ref.indexOf("*");
  const slashIndex = ref.lastIndexOf("/", starIndex);
  const dirRef = ref.slice(0, slashIndex);
  const prefix = ref.slice(slashIndex + 1, starIndex);
  const suffix = ref.slice(starIndex + 1);
  const entries = await fs.readdir(path.join(repoRoot, dirRef));
  return entries.some((entry) => entry.startsWith(prefix) && entry.endsWith(suffix));
}

const failures = [];
let checked = 0;

for (const file of docs) {
  const relFile = path.relative(repoRoot, file);
  const text = await fs.readFile(file, "utf8");
  for (const match of text.matchAll(referencePattern)) {
    const ref = match[1];
    checked += 1;
    const ok = ref.includes("*") ? await globHasMatch(ref) : await literalExists(ref);
    if (!ok) failures.push(`${relFile}: missing ${ref}`);
  }
}

if (failures.length > 0) {
  console.error("docs path reference smoke failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`docs path reference smoke passed (${checked} references checked)`);
