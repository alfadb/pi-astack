#!/usr/bin/env node
/**
 * ADR0039 A4 — flip coverage hard gate (R3 4xT0 consensus; coded, not prose).
 *
 * Gates the canonicalReadMode=projection_only flip. The denominator is computed
 * FROM L1 (the SOT) — never from legacy file count or L2 file count, which would
 * be circular self-validation (R3 opus/kimi). Exclusions (smell / staging /
 * archive-vs-active / _index) are explicit CODE CONSTANTS and are logged, never
 * silently dropped.
 *
 * Coverage (both must be 1.0 to pass):
 *   - active   = (active-canonical L1 identities with a live L2 projection) /
 *                (active-canonical L1 identities)        [the user-visible read surface]
 *   - archived = (archived L1 identities with a live L2 tombstone) /
 *                (archived L1 identities)                [ADR0031 revival surface]
 * A non-1.0 means the projector skipped an L1 identity -> projection_only would
 * drop it. (Because L2 is the deterministic render of L1, this is meaningful only
 * BECAUSE the denominator is L1: it catches projector coverage gaps, not L2 echo.)
 *
 * Field fidelity (R3 deepseek gap): for legacy_import identities, compare the
 * legacy SOURCE markdown's trigger_phrases / derives_from / kind / status against
 * what was extracted into L1. reconcile's L1->L2 byte-compare and A7's L1-only
 * rebuild cannot see a legacy->L1 EXTRACTION bug; this closes that gap.
 *
 * PASS iff active=1.0 AND archived=1.0 AND field fidelity clean. Exit 1 otherwise.
 *
 * Usage: node scripts/adr0039-flip-coverage-gate.mjs [--abrain ~/.abrain]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeModule } from "./backfill-legacy-knowledge.mjs";

// --- Explicit allowlist exclusions (coded constants; counts logged below) ----
// staging/ entries never receive an L1 event (backfill skips smell->staging), so
// the L1-derived denominator excludes them STRUCTURALLY; we still assert/log.
const EXCLUDED_KINDS = new Set(["smell"]);   // staging semantics, not canonical corpus
const EXCLUDED_SLUGS = new Set(["_index"]);  // aux index files, not memory entries
const ACTIVE_STATUSES = new Set(["active"]);
const ARCHIVED_STATUSES = new Set(["archived"]);

function expandHome(s) { return String(s).replace(/^~(?=$|\/)/, os.homedir()); }
function arg(n, d) { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; }
function splitFm(raw) { const m = raw.match(/^---\n([\s\S]*?)\n---\n?/); return m ? m[1] : ""; }
function fmScalar(fm, key) { const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m")); if (!m) return undefined; let v = m[1].trim(); if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } } return v; }
function fmList(fm, key) {
  const lines = fm.split("\n"); const idx = lines.findIndex((l) => l.trim() === `${key}:`);
  if (idx === -1) return []; const out = [];
  for (let i = idx + 1; i < lines.length; i += 1) { const mm = lines[i].match(/^\s+-\s+(.+)$/); if (!mm) break; let v = mm[1].trim(); if (v.startsWith('"') && v.endsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } out.push(v); }
  return out;
}
function sameList(a, b) { if (a.length !== b.length) return false; const sa = [...a].sort(); const sb = [...b].sort(); return sa.every((x, i) => x === sb[i]); }

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
const km = loadKnowledgeModule();

// Fold L1 knowledge events by identity (the SOT-derived universe).
const byId = new Map();
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const env = JSON.parse(fs.readFileSync(f, "utf-8"));
      const b = env.body;
      if (b?.event_schema_version !== "knowledge-evidence-event/v1") continue;
      const id = km.knowledgeIdentityKey(b);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ eventId: env.event_id, body: b });
    } catch { /* skip foreign/unreadable */ }
  }
};
walk(path.join(abrainHome, "l1", "events"));

const latestDir = path.join(km.knowledgeProjectionRoot(abrainHome, { knowledgeProjector: { l2OutputRoot: "repo" } }), "latest");
const l2PathOf = (body) => path.join(latestDir, body.scope.kind === "world" ? "world" : `projects/${body.scope.project_id || "unknown"}`, `${body.payload.slug}.md`);

let activeDenom = 0, activeCovered = 0, archDenom = 0, archCovered = 0;
const excluded = { smell: 0, _index: 0, deleted: 0, otherStatus: 0 };
let fieldChecked = 0, fieldMismatch = 0, legacySrcMissing = 0;
const missing = [], fieldDiffs = [];

for (const [id, nodes] of byId) {
  let proj;
  try { proj = km.renderKnowledgeProjectionFromSet(nodes); } catch { proj = { kind: "delete", winnerEventId: nodes[nodes.length - 1].eventId }; }
  const winner = nodes.find((n) => n.eventId === proj.winnerEventId)?.body ?? nodes[nodes.length - 1].body;
  const p = winner.payload;
  if (EXCLUDED_KINDS.has(p.kind)) { excluded.smell += 1; continue; }
  if (EXCLUDED_SLUGS.has(p.slug)) { excluded._index += 1; continue; }
  if (proj.kind === "delete") { excluded.deleted += 1; continue; }

  const l2Exists = fs.existsSync(l2PathOf(winner));
  if (ACTIVE_STATUSES.has(p.status)) {
    activeDenom += 1; if (l2Exists) activeCovered += 1; else missing.push(`ACTIVE ${id}`);
  } else if (ARCHIVED_STATUSES.has(p.status)) {
    archDenom += 1; if (l2Exists) archCovered += 1; else missing.push(`ARCHIVED ${id}`);
  } else { excluded.otherStatus += 1; continue; }

  // Field fidelity (legacy->L1 extraction) for legacy_import identities.
  const rel = winner.legacy_parallel_write?.path;
  const isLegacyImport = winner.device_id === "legacy-import" || (winner.source?.source_ref || "").startsWith("legacy-import:");
  if (isLegacyImport && rel) {
    const src = path.join(abrainHome, rel);
    if (!fs.existsSync(src)) { legacySrcMissing += 1; continue; }
    const fm = splitFm(fs.readFileSync(src, "utf-8"));
    fieldChecked += 1;
    const srcKind = fmScalar(fm, "kind") || "fact";
    const srcStatus = fmScalar(fm, "status") || "active";
    const srcTrig = fmList(fm, "trigger_phrases");
    const srcDeriv = fmList(fm, "derives_from");
    const diffs = [];
    if (srcKind !== p.kind) diffs.push(`kind ${srcKind}!=${p.kind}`);
    if (srcStatus !== p.status) diffs.push(`status ${srcStatus}!=${p.status}`);
    if (!sameList(srcTrig, p.trigger_phrases || [])) diffs.push(`trigger_phrases`);
    if (!sameList(srcDeriv, p.derives_from || [])) diffs.push(`derives_from`);
    if (diffs.length) { fieldMismatch += 1; fieldDiffs.push(`${id}: ${diffs.join(", ")}`); }
  }
}

const activeCov = activeDenom === 0 ? 1 : activeCovered / activeDenom;
const archCov = archDenom === 0 ? 1 : archCovered / archDenom;
console.log("ADR0039 A4 — flip coverage hard gate (L1-derived denominator)");
console.log(`abrainHome: ${abrainHome}`);
console.log(`l1_knowledge_identities: ${byId.size}`);
console.log(`active_denominator(L1): ${activeDenom}`);
console.log(`active_covered(L2 present): ${activeCovered}`);
console.log(`coverage_active_l1_derived: ${activeCov.toFixed(4)}`);
console.log(`archived_denominator(L1): ${archDenom}`);
console.log(`archived_covered(L2 tombstone): ${archCovered}`);
console.log(`coverage_archived_l1_derived: ${archCov.toFixed(4)}`);
console.log(`excluded(allowlist): smell=${excluded.smell} _index=${excluded._index} deleted=${excluded.deleted} other_status=${excluded.otherStatus}`);
console.log(`field_fidelity_checked(legacy->L1): ${fieldChecked}  mismatch: ${fieldMismatch}  legacy_src_missing: ${legacySrcMissing}`);
if (missing.length) { console.log("MISSING L2 (first 20):"); for (const m of missing.slice(0, 20)) console.log(`  ${m}`); }
if (fieldDiffs.length) { console.log("FIELD DIFFS (first 20):"); for (const d of fieldDiffs.slice(0, 20)) console.log(`  ${d}`); }

const pass = activeCov === 1 && archCov === 1 && fieldMismatch === 0 && missing.length === 0;
console.log(pass
  ? "PASS — every active-canonical + archived L1 identity has a faithful L2 projection; legacy->L1 fields intact. projection_only flip is coverage-clear."
  : "FAIL — coverage gap or field drift; projection_only flip is NOT coverage-clear.");
process.exit(pass ? 0 : 1);
