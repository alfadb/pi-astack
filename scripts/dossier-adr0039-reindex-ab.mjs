#!/usr/bin/env node
/**
 * ADR 0039 Phase B-prep blocker② — REQ-009 embedding freshness cross-inversion A/B.
 *
 * User-initiated diagnostic. Read-only against the brain repo; writes NOTHING to
 * canonical memory and registers no runtime hooks. It answers the REQ-009
 * question for the Knowledge canonical=projection flip:
 *
 *   When loadEntries flips from legacy-canonical markdown to l2/ projection
 *   markdown for the SAME slug, does the embedding index (keyed by
 *   slug + contentHashOf, where contentBasis = title+summary+compiledTruth
 *   +timeline) go stale, and does staleOrMissingSlugs auto-recover?
 *
 * Method (faithful, real production corpus, no API calls for the deterministic
 * core): transpile the memory module, parseEntry() the legacy AND projection
 * markdown for every shared slug, compute contentHashOf for both, bucket the
 * deltas (identical / timeline-only / semantic), then drive the REAL
 * staleOrMissingSlugs + VectorIndex to prove the flip is detected and a single
 * re-embed clears it.
 *
 * Usage:
 *   node scripts/dossier-adr0039-reindex-ab.mjs            # defaults --abrain ~/.abrain
 *   node scripts/dossier-adr0039-reindex-ab.mjs --abrain /tmp/x --limit 200
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
function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
}
/** Stage every .ts under the given extension dirs as .js in outRoot. We require
 *  only memory/parser + memory/embedding, so heavy leaves (adr0039-l3/sqlite,
 *  writer) are transpiled but never loaded. */
function stageDirs(outRoot, dirs) {
  let count = 0;
  for (const dir of dirs) {
    const srcDir = path.join(repoRoot, "extensions", dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      writeFile(path.join(outRoot, dir, file.replace(/\.ts$/, ".js")), transpile(fs.readFileSync(path.join(srcDir, file), "utf8")));
      count++;
    }
  }
  return count;
}

function listMarkdown(root) {
  const out = [];
  function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  walk(root);
  return out;
}

async function buildSlugMap(parseEntry, files, scope, root, label) {
  const map = new Map();
  const store = { scope, root, label };
  for (const file of files) {
    const entry = await parseEntry(file, store, root);
    if (entry && entry.slug) map.set(entry.slug, entry);
  }
  return map;
}

async function main() {
  const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
  const limit = Number(arg("limit", "Infinity"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "adr0039-reindex-ab-"));
  const staged = stageDirs(out, ["_shared", "memory", "sediment"]);
  const { parseEntry } = require(path.join(out, "memory", "parser.js"));
  const { contentHashOf, staleOrMissingSlugs, VectorIndex } = require(path.join(out, "memory", "embedding.js"));

  // ── Enumerate legacy-canonical stores ──
  const legacy = new Map();
  const legacyWorldRoot = path.join(abrainHome, "knowledge");
  for (const [k, v] of await buildSlugMap(parseEntry, listMarkdown(legacyWorldRoot), "world", legacyWorldRoot, "legacy-world")) legacy.set(k, v);
  const projectsRoot = path.join(abrainHome, "projects");
  if (fs.existsSync(projectsRoot)) {
    for (const pid of fs.readdirSync(projectsRoot)) {
      const pdir = path.join(projectsRoot, pid);
      if (!fs.statSync(pdir).isDirectory()) continue;
      const m = await buildSlugMap(parseEntry, listMarkdown(pdir), "project", pdir, `legacy-project:${pid}`);
      for (const [k, v] of m) legacy.set(k, v);
    }
  }

  // ── Enumerate projection-canonical stores (l2/) ──
  const proj = new Map();
  const l2World = path.join(abrainHome, "l2", "views", "knowledge", "latest", "world");
  for (const [k, v] of await buildSlugMap(parseEntry, listMarkdown(l2World), "world", l2World, "proj-world")) proj.set(k, v);
  const l2Projects = path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects");
  if (fs.existsSync(l2Projects)) {
    for (const pid of fs.readdirSync(l2Projects)) {
      const pdir = path.join(l2Projects, pid);
      if (!fs.statSync(pdir).isDirectory()) continue;
      for (const [k, v] of await buildSlugMap(parseEntry, listMarkdown(pdir), "project", pdir, `proj-project:${pid}`)) proj.set(k, v);
    }
  }

  // ── A/B contentHash diff over shared slugs ──
  const shared = [...proj.keys()].filter((s) => legacy.has(s));
  const buckets = { identical: [], timelineOnly: [], semantic: [] };
  const fieldChange = (a, b) => ({
    title: a.title !== b.title,
    compiledTruth: a.compiledTruth !== b.compiledTruth,
    timeline: (a.timeline || []).join("\n") !== (b.timeline || []).join("\n"),
  });
  let processed = 0;
  for (const slug of shared) {
    if (processed >= limit) break;
    processed++;
    const L = legacy.get(slug), P = proj.get(slug);
    const hL = contentHashOf(L), hP = contentHashOf(P);
    if (hL === hP) { buckets.identical.push(slug); continue; }
    const fc = fieldChange(L, P);
    if (fc.title || fc.compiledTruth) buckets.semantic.push({ slug, fc });
    else buckets.timelineOnly.push(slug);
  }

  // ── staleOrMissingSlugs auto-recovery (real mechanism) ──
  const idxFile = path.join(out, "vec-index.json");
  const idx = new VectorIndex(idxFile, "dummy-model", 4);
  const sampleEntries = shared.slice(0, processed).map((s) => proj.get(s));
  // Seed index with LEGACY content hashes (the pre-flip state).
  for (const s of shared.slice(0, processed)) {
    const L = legacy.get(s);
    idx.upsert(L.slug, contentHashOf(L), [[0, 0, 0, 0]], L.scope, "s");
  }
  const flaggedAfterFlip = staleOrMissingSlugs(idx, sampleEntries);
  // Re-embed: upsert PROJECTION hashes (post-flip).
  for (const s of shared.slice(0, processed)) {
    const P = proj.get(s);
    idx.upsert(P.slug, contentHashOf(P), [[0, 0, 0, 0]], P.scope, "s");
  }
  const flaggedAfterReembed = staleOrMissingSlugs(idx, sampleEntries);

  const expectFlagged = new Set([...buckets.timelineOnly, ...buckets.semantic.map((x) => x.slug)]);
  const flaggedSet = new Set(flaggedAfterFlip);
  const flaggedMatchesChanged = flaggedSet.size === expectFlagged.size && [...expectFlagged].every((s) => flaggedSet.has(s));

  const report = {
    abrainHome,
    staged_files: staged,
    legacy_slugs: legacy.size,
    projection_slugs: proj.size,
    shared_slugs: shared.length,
    processed,
    contentbasis: "title + summary(fn of compiledTruth,title) + compiledTruth + timeline",
    buckets: {
      identical: buckets.identical.length,
      timeline_only_diff: buckets.timelineOnly.length,
      semantic_diff: buckets.semantic.length,
    },
    stale_mechanism: {
      flagged_after_flip: flaggedAfterFlip.length,
      flagged_equals_changed_set: flaggedMatchesChanged,
      flagged_after_reembed: flaggedAfterReembed.length,
      auto_recovered: flaggedAfterReembed.length === 0,
    },
    semantic_diff_samples: buckets.semantic.slice(0, 10),
    timeline_only_samples: buckets.timelineOnly.slice(0, 5),
  };
  console.log(JSON.stringify(report, null, 2));

  // ── Verdict (REQ-009 P6 regression gate) ──
  const pass =
    flaggedMatchesChanged &&
    flaggedAfterReembed.length === 0 &&
    buckets.semantic.length === 0; // semantic (title/compiledTruth) drift is the only true recall risk
  console.log(pass
    ? "PASS — REQ-009: flip changes only timeline-derived hashes; staleOrMissingSlugs flags exactly the changed set and a single re-embed recovers; ZERO semantic (title/compiledTruth) drift → no recall regression."
    : `REVIEW — semantic_diff=${buckets.semantic.length} flagged_matches_changed=${flaggedMatchesChanged} auto_recovered=${flaggedAfterReembed.length === 0}. Semantic drift > 0 means projection lost/altered title/compiledTruth vs legacy — gate the flip until fixed.`);
  fs.rmSync(out, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(2); });
