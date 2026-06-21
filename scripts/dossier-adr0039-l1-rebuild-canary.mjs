#!/usr/bin/env node
/**
 * ADR0039 A7 — L1-only rebuild canary (R3 4xT0 consensus, flip prerequisite).
 *
 * Conceptually discards the live L2 view: re-renders every Knowledge identity
 * from L1 events ONLY (via the deterministic renderer) and byte-compares against
 * the live l2/views/knowledge/latest tree. 0 diff proves three invariants at once:
 *   - A1 (I-L2R): L2 is reconstructable from L1 alone (compiled_truth carries the
 *     full body; legacy markdown is NOT a rebuild source).
 *   - L2 renderer determinism (same L1 set -> same canonical bytes).
 *   - archived-tombstone fidelity (status=archived entries render full-text).
 *
 * Read-only: renders in memory, never writes the live tree. Exit 1 on any diff.
 * Per R3 D4 (kimi), this should run as a PERIODIC dossier, not a one-shot gate:
 * a snapshot pass does not prove continued-write fidelity.
 *
 * Usage: node scripts/dossier-adr0039-l1-rebuild-canary.mjs [--abrain ~/.abrain]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeModule } from "./backfill-legacy-knowledge.mjs";

function expandHome(input) { return String(input).replace(/^~(?=$|\/)/, os.homedir()); }
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const abrainHome = path.resolve(expandHome(arg("abrain", path.join(os.homedir(), ".abrain"))));
const km = loadKnowledgeModule();

// Group L1 knowledge events by identity (mirrors reprojectAllKnowledge's fold).
const eventsRoot = path.join(abrainHome, "l1", "events");
const byIdentity = new Map();
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const env = JSON.parse(fs.readFileSync(full, "utf-8"));
      const body = env.body;
      if (body?.event_schema_version !== "knowledge-evidence-event/v1") continue;
      const id = km.knowledgeIdentityKey(body);
      if (!byIdentity.has(id)) byIdentity.set(id, []);
      byIdentity.get(id).push({ eventId: env.event_id, body });
    } catch { /* skip unreadable/foreign */ }
  }
};
walk(eventsRoot);

const projectionRoot = km.knowledgeProjectionRoot(abrainHome, { knowledgeProjector: { l2OutputRoot: "repo" } });
const latestDir = path.join(projectionRoot, "latest");

let checked = 0, byteMatch = 0, mismatch = 0, missingLive = 0, staleLive = 0, archivedChecked = 0, renderFail = 0;
const diffs = [];
for (const [identity, nodes] of byIdentity) {
  let proj;
  try { proj = km.renderKnowledgeProjectionFromSet(nodes); }
  catch (err) { renderFail += 1; diffs.push(`RENDER_FAIL: ${identity}: ${err instanceof Error ? err.message : String(err)}`); continue; }
  const body = nodes[0].body;
  const part = body.scope.kind === "world" ? "world" : `projects/${body.scope.project_id || "unknown"}`;
  const livePath = path.join(latestDir, part, `${body.payload.slug}.md`);
  checked += 1;
  if (proj.kind === "delete") {
    if (fs.existsSync(livePath)) { staleLive += 1; diffs.push(`STALE_LIVE (rendered=delete but present): ${identity}`); }
    continue;
  }
  if (!fs.existsSync(livePath)) { missingLive += 1; diffs.push(`MISSING_LIVE: ${identity}`); continue; }
  const isArchived = /^status: archived$/m.test(proj.markdown);
  if (isArchived) archivedChecked += 1;
  if (fs.readFileSync(livePath, "utf-8") === proj.markdown) byteMatch += 1;
  else { mismatch += 1; diffs.push(`MISMATCH${isArchived ? " (archived tombstone)" : ""}: ${identity}`); }
}

console.log("ADR0039 A7 — L1-only rebuild canary");
console.log(`abrainHome: ${abrainHome}`);
console.log(`identities_from_L1: ${byIdentity.size}`);
console.log(`checked: ${checked}`);
console.log(`byte_match: ${byteMatch}`);
console.log(`mismatch: ${mismatch}`);
console.log(`missing_live: ${missingLive}`);
console.log(`stale_live: ${staleLive}`);
console.log(`render_fail: ${renderFail}`);
console.log(`archived_tombstones_checked: ${archivedChecked}`);
const clean = mismatch === 0 && missingLive === 0 && staleLive === 0 && renderFail === 0;
if (!clean) { console.log("DIFFS (first 25):"); for (const d of diffs.slice(0, 25)) console.log(`  ${d}`); }
console.log(clean
  ? "PASS — live L2 is byte-identical to an L1-only rebuild (A1 + renderer determinism + archived fidelity hold)."
  : "FAIL — live L2 diverges from L1-only rebuild.");
process.exit(clean ? 0 : 1);
