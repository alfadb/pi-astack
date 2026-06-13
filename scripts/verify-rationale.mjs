#!/usr/bin/env node
/**
 * ADR 0034 §2.3 rationale-availability verifier (acceptance ⑨ gate).
 *
 * Loads an ingested entry from the REAL ~/.abrain via the real parser and
 * renders its rationale. Used to confirm rationale is obtainable from abrain
 * BEFORE physically slimming the source ADR prose. Read-only.
 *
 * Usage: node scripts/verify-rationale.mjs --slug <slug> [--project pi-global] [--abrain ~/.abrain]
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const slug = arg("slug");
const projectId = arg("project", "pi-global");
const abrainHome = path.resolve(arg("abrain", path.join(os.homedir(), ".abrain")));
if (!slug) { console.error("usage: --slug <slug> [--project pi-global]"); process.exit(2); }

function transpileDirs(outRoot, dirs) {
  for (const dir of dirs) {
    const srcDir = path.join(repoRoot, "extensions", dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.NodeJs, esModuleInterop: true, skipLibCheck: true },
      }).outputText;
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-rationale-"));
transpileDirs(tmp, ["_shared", "memory", "sediment"]);
const { parseEntry } = require(path.join(tmp, "memory", "parser.js"));
const { renderRationaleFromEntry, formatRationale } = require(path.join(tmp, "memory", "rationale.js"));

const projectDir = path.join(abrainHome, "projects", projectId);
const file = path.join(projectDir, `${slug}.md`);
const store = { scope: "project", root: projectDir, label: projectId };

const entry = await parseEntry(file, store, repoRoot);
const r = renderRationaleFromEntry(slug, entry);
console.log(formatRationale(r));
console.log(`\n[verify] found=${r.found} sourceRef=${r.evidence.sourceRef ? "yes" : "NO"} directionImpact=${r.directionImpact.length} codeSymbols=${r.evidence.codeSymbols.length}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.found && r.evidence.sourceRef ? 0 : 1);
