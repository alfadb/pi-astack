#!/usr/bin/env node
// ADR0039 Knowledge coverage probe (read-only). Measures legacy→L1 coverage:
// every legacy canonical Knowledge entry (global knowledge/ + project
// knowledge|decisions|maxims zones) should have a matching L1 knowledge event
// (real agent_end OR legacy_import). This probe does NOT write or backfill —
// it reports the coverage ratio and lists the legacy-only (unresolved) items so
// the next Knowledge migration slice can decide backfill vs defer-with-evidence
// per item. Reuses the exported enumerators from backfill-legacy-knowledge.mjs.
//
// Usage: node scripts/knowledge-coverage-probe.mjs [--home ~/.abrain] [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeModule, legacyKnowledgeEntries, collectKnowledgeIdentities } from "./backfill-legacy-knowledge.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const abrainHome = path.resolve(expandHome(arg("--home", path.join(os.homedir(), ".abrain"))));
const asJson = process.argv.includes("--json");

if (!fs.existsSync(abrainHome)) {
  console.error(`abrain home not found: ${abrainHome}`);
  process.exit(2);
}

const km = loadKnowledgeModule();
const entries = legacyKnowledgeEntries(abrainHome);
const covered = collectKnowledgeIdentities(km, abrainHome); // Set of identity keys present in any L1 knowledge event

function identityOf(entry) {
  return entry.scope === "world" ? `world::${entry.slug}` : `project:${entry.projectId}:${entry.slug}`;
}
function zoneOf(entry) {
  if (entry.scope === "world") return "knowledge";
  const rel = path.relative(path.join(abrainHome, "projects", entry.projectId), entry.file).split(path.sep);
  return rel[0] || "?";
}

const missing = [];
let coveredCount = 0;
for (const entry of entries) {
  if (covered.has(identityOf(entry))) { coveredCount += 1; continue; }
  missing.push({
    identity: identityOf(entry),
    scope: entry.scope,
    projectId: entry.projectId ?? null,
    zone: zoneOf(entry),
    slug: entry.slug,
    rel: path.relative(abrainHome, entry.file).split(path.sep).join("/"),
  });
}

const total = entries.length;
const ratio = total === 0 ? 1 : coveredCount / total;

// Group the unresolved (legacy-only) items.
const byProject = new Map();
const byZone = new Map();
for (const m of missing) {
  const pk = m.scope === "world" ? "(world)" : m.projectId;
  byProject.set(pk, (byProject.get(pk) ?? 0) + 1);
  byZone.set(m.zone, (byZone.get(m.zone) ?? 0) + 1);
}

if (asJson) {
  console.log(JSON.stringify({
    abrainHome,
    l1KnowledgeIdentities: covered.size,
    legacyEntries: total,
    covered: coveredCount,
    legacyOnlyUnresolved: missing.length,
    coverageRatio: Number(ratio.toFixed(6)),
    deferredWithEvidence: 0, // no defer-marker mechanism exists yet (only delete-tombstones)
    byProject: Object.fromEntries([...byProject].sort((a, b) => b[1] - a[1])),
    byZone: Object.fromEntries([...byZone].sort((a, b) => b[1] - a[1])),
    unresolved: missing,
  }, null, 2));
  process.exit(0);
}

console.log(`# Knowledge coverage probe (read-only) — ${abrainHome}`);
console.log("");
console.log(`L1 knowledge identities (real + legacy_import) : ${covered.size}`);
console.log(`legacy canonical entries (knowledge|decisions|maxims) : ${total}`);
console.log(`covered (legacy entry has an L1 event)         : ${coveredCount}`);
console.log(`legacy-only / unresolved                       : ${missing.length}`);
console.log(`coverage ratio (covered / legacy)              : ${ratio.toFixed(4)}`);
console.log(`marked-for-defer-with-evidence                 : 0 (no defer-marker mechanism exists; only delete-tombstones)`);
console.log("");
console.log("## unresolved by project");
for (const [pk, n] of [...byProject].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${pk}`);
console.log("");
console.log("## unresolved by zone");
for (const [zk, n] of [...byZone].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${zk}`);
console.log("");
console.log("## unresolved items (identity)");
for (const m of missing.sort((a, b) => a.identity.localeCompare(b.identity))) console.log(`  ${m.identity}  [${m.zone}]  ${m.rel}`);
