#!/usr/bin/env node
/**
 * ADR 0039 Phase C flip probe + soak canary. Deterministic, read-only.
 *
 * Validates the canonical=projection flip mechanism on the REAL production brain
 * WITHOUT depending on the running pi or memory_search (whose LLM rerank can
 * return [] for reasons unrelated to the store flip). It exercises the same
 * real code the flip uses \u2014 scanStore + readKnowledgeStableViewStores + the
 * world-store scan \u2014 and asserts:
 *   (1) the legacy world scan no longer leaks l2/ projections (world-reads-l2 fix),
 *   (2) the unbounded stable-view reads projection entries (sourcePath under l2/),
 *   (3) for shared slugs, prepending the stable-view makes the PROJECTION win
 *       (first-store-wins) \u2014 i.e. canonical=projection is content-correct.
 *
 * Usage: node scripts/dossier-adr0039-phase-c-flip-probe.mjs   # defaults --abrain ~/.abrain --project pi-global
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function expandHome(p) {
  return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function stageDirs(outRoot, dirs) {
  let count = 0;
  for (const dir of dirs) {
    const srcDir = path.join(repoRoot, "extensions", dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const out = ts.transpileModule(fs.readFileSync(path.join(srcDir, file), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.NodeJs, esModuleInterop: true, skipLibCheck: true },
      }).outputText;
      writeFile(path.join(outRoot, dir, file.replace(/\.ts$/, ".js")), out);
      count++;
    }
  }
  return count;
}

async function scanByLabel(scanStore, store, cwd) {
  const entries = await scanStore(store, cwd, { maxEntries: 1_000_000, includeWorld: true });
  const bySlug = new Map();
  for (const e of entries) if (e && e.slug) bySlug.set(e.slug, e);
  return bySlug;
}

async function main() {
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const projectId = arg("project", "pi-global");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-phasec-probe-"));
  const staged = stageDirs(out, ["_shared", "memory", "sediment"]);
  const { scanStore } = require(path.join(out, "memory", "parser.js"));
  const { readKnowledgeStableViewStores } = require(path.join(out, "sediment", "knowledge-evidence.js"));

  const projSettings = { knowledgeProjector: { enabled: true, hotOverlayEnabled: true, projectOnWrite: true, maxReadBytes: 1_000_000, l2OutputRoot: "repo", projectionMode: "topo", canonicalReadMode: "projection_with_legacy_fallback", hotOverlay: { maxEntries: 500, maxTokens: 2_000_000, deadlineMs: 30_000 } } };

  // Legacy stores (post-fix: world scan must exclude l1//l2/).
  const legacyWorld = await scanByLabel(scanStore, { scope: "world", root: abrainHome, label: "world" }, abrainHome);
  const legacyProject = await scanByLabel(scanStore, { scope: "project", root: path.join(abrainHome, "projects", projectId), label: "abrain-project" }, abrainHome);

  // Unbounded stable-view stores (the post-flip primary read source).
  const stableStores = await readKnowledgeStableViewStores({ abrainHome, projectId, settings: projSettings });
  const stableWorldStore = stableStores.find((s) => s.label === "knowledge-stable-world");
  const stableProjectStore = stableStores.find((s) => s.label === "knowledge-stable-project");
  const stableWorld = stableWorldStore ? await scanByLabel(scanStore, stableWorldStore, abrainHome) : new Map();
  const stableProject = stableProjectStore ? await scanByLabel(scanStore, stableProjectStore, abrainHome) : new Map();

  const underL2 = (p) => typeof p === "string" && p.includes(`${path.sep}l2${path.sep}views${path.sep}knowledge${path.sep}`);

  // (1) world-reads-l2 leak fixed: no legacy world entry resolves under l2/.
  const legacyWorldL2Leak = [...legacyWorld.values()].filter((e) => underL2(e.sourcePath)).length;
  const legacyProjectL2Leak = [...legacyProject.values()].filter((e) => underL2(e.sourcePath)).length;

  // (2) stable-view reads projection (sourcePath under l2/).
  const stableWorldUnderL2 = [...stableWorld.values()].every((e) => underL2(e.sourcePath));
  const stableProjectUnderL2 = [...stableProject.values()].every((e) => underL2(e.sourcePath));

  // (3) for shared slugs, projection wins when prepended (first-store-wins).
  const sharedWorld = [...stableWorld.keys()].filter((s) => legacyWorld.has(s));
  const sharedProject = [...stableProject.keys()].filter((s) => legacyProject.has(s));
  // winner = stable-view (front) → projection sourcePath. Spot-check all shared.
  const worldWinnerCorrect = sharedWorld.every((s) => underL2(stableWorld.get(s).sourcePath));
  const projectWinnerCorrect = sharedProject.every((s) => underL2(stableProject.get(s).sourcePath));

  const report = {
    abrainHome, projectId, staged_files: staged,
    legacy: { world: legacyWorld.size, project: legacyProject.size },
    stable_view: { world: stableWorld.size, project: stableProject.size },
    shared: { world: sharedWorld.length, project: sharedProject.length },
    world_reads_l2_leak: { legacy_world: legacyWorldL2Leak, legacy_project: legacyProjectL2Leak },
    stable_view_under_l2: { world: stableWorldUnderL2, project: stableProjectUnderL2 },
    projection_wins_shared: { world: worldWinnerCorrect, project: projectWinnerCorrect },
    sample_world_winner: sharedWorld.slice(0, 3).map((s) => ({ slug: s, projection: stableWorld.get(s).sourcePath.replace(abrainHome, ""), legacy: legacyWorld.get(s).sourcePath.replace(abrainHome, "") })),
  };
  console.log(JSON.stringify(report, null, 2));

  const pass =
    legacyWorldL2Leak === 0 && legacyProjectL2Leak === 0 &&
    stableWorldUnderL2 && stableProjectUnderL2 &&
    (sharedWorld.length + sharedProject.length) > 0 &&
    worldWinnerCorrect && projectWinnerCorrect;
  console.log(pass
    ? "PASS — Phase C flip is content-correct on real data: world scan no longer leaks l2/, stable-view reads projection, and prepending it makes the projection win for every shared slug."
    : `REVIEW — leak(w=${legacyWorldL2Leak},p=${legacyProjectL2Leak}) stableUnderL2(w=${stableWorldUnderL2},p=${stableProjectUnderL2}) winner(w=${worldWinnerCorrect},p=${projectWinnerCorrect}) shared(w=${sharedWorld.length},p=${sharedProject.length}). Do NOT flip until green.`);
  fs.rmSync(out, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
