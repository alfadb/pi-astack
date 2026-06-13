#!/usr/bin/env node
/**
 * ADR 0034 one-shot ingest RUNNER (Phase 4 migration vehicle).
 *
 * Reads a decomposer-response JSON, runs the ingest lane against the REAL
 * ~/.abrain via the legitimate sediment write path (atomicWrite + git commit).
 * Defaults to dry-run; pass --go to actually write. This is the user-initiated
 * bounded migration sanctioned by ADR 0034 §5 (NOT a steady-state main-session
 * writer). All writes are git-committed in ~/.abrain → recoverable.
 *
 * Usage:
 *   node scripts/run-adr-ingest.mjs --json <file> --adr <relpath> --sha <sha> \
 *        [--project pi-global] [--abrain ~/.abrain] [--go]
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
const GO = process.argv.includes("--go");
const jsonFile = arg("json");
const adrPath = arg("adr");
const sha = arg("sha");
const projectId = arg("project", "pi-global");
const abrainHome = path.resolve(arg("abrain", path.join(os.homedir(), ".abrain")));
if (!jsonFile || !adrPath || !sha) {
  console.error("usage: --json <file> --adr <relpath> --sha <sha> [--project pi-global] [--abrain ~/.abrain] [--go]");
  process.exit(2);
}

function transpileDirs(outRoot, dirs) {
  for (const dir of dirs) {
    const srcDir = path.join(repoRoot, "extensions", dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-ingest-"));
transpileDirs(tmp, ["_shared", "memory", "sediment"]);

const { parseDecomposerResponse } = require(path.join(tmp, "memory", "adr-decomposer.js"));
const { runAdrIngest } = require(path.join(tmp, "memory", "ingest-adr.js"));
const { sanitizeForMemory } = require(path.join(tmp, "sediment", "sanitizer.js"));
const { DEFAULT_SETTINGS } = require(path.join(tmp, "memory", "settings.js"));

const jsonText = fs.readFileSync(path.resolve(jsonFile), "utf-8");
const parsed = parseDecomposerResponse(jsonText, adrPath, sha);
if (parsed.error) {
  console.error(`decompose parse error: ${parsed.error}`);
  process.exit(1);
}

const timestamp = new Date().toISOString();

const run = await runAdrIngest({
  abrainHome,
  projectId,
  sources: [parsed.source],
  dryRun: !GO,
  settings: DEFAULT_SETTINGS,
  sanitize: (s) => sanitizeForMemory(s),
  cwd: repoRoot,
  timestamp,
});

const m = run.manifest;
console.log(`\n=== ADR ingest ${GO ? "[--go WRITE]" : "[dry-run]"} : ${adrPath} @ ${sha} → project ${projectId} ===`);
console.log(`abrainHome: ${abrainHome}`);
console.log(`\n-- manifest: ${m.entries.length} entries, ${m.totalIssues} issues --`);
for (const e of m.entries) {
  const flag = e.issues.length ? `  ⚠ ISSUES: ${e.issues.join("; ")}` : "";
  console.log(`  [${e.kind}] ${e.slug}  (body ${e.bodyLength}c, di ${e.directionImpactCount})  ← ${e.sourceRef}${flag}`);
}
console.log(`\n-- coverage --`);
for (const c of m.coverage) {
  console.log(`  ${c.adrPath}: processed ${c.processed.length}, skipped ${c.skipped.length}, entries ${c.entryCount}`);
  for (const s of c.skipped) console.log(`    skip: ${s.heading} — ${s.reason}`);
}
if (m.flags.length) {
  console.log(`\n-- advisory flags (NOT blocking) --`);
  for (const f of m.flags) console.log(`  • ${f}`);
}
console.log(`\n-- result --`);
console.log(`  ok=${run.ok} dryRun=${run.dryRun}`);
console.log(`  written(${run.written.length}): ${run.written.join(", ") || "—"}`);
console.log(`  skippedWithIssues(${run.skippedWithIssues.length}): ${run.skippedWithIssues.join(", ") || "—"}`);
console.log(`  failed(${run.failed.length}): ${run.failed.map((f) => `${f.slug}:${f.reason}`).join(", ") || "—"}`);
if (GO) {
  console.log(`  abrainPreSha=${run.abrainPreSha}  commitSha=${run.commitSha || "—"}  rolledBack=${run.rolledBack || false}`);
  console.log(`  graphRebuilt=${run.graphRebuilt ? JSON.stringify(run.graphRebuilt) : "—"}`);
  if (run.error) console.log(`  error=${run.error}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(run.ok ? 0 : 1);
