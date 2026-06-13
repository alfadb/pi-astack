#!/usr/bin/env node
/**
 * Smoke test for ADR 0034 §2.3 rationale rendering (Phase 3).
 *
 * Core hard constraint (acceptance ⑧): missing → explicit no-fabrication fallback,
 * never invented content. Also verifies grounding (rendered text is a substring of
 * the stored body), pinned source_ref surfacing (revision #8), and honest gaps.
 * Pure functions; no pi runtime.
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

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  passed++;
}

function transpileDirs(outRoot, dirs) {
  const extRoot = path.join(repoRoot, "extensions");
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-rationale-"));
transpileDirs(tmp, ["memory"]);
const R = require(path.join(tmp, "memory", "rationale.js"));
const { renderRationaleFromEntry, renderRationale, formatRationale } = R;

const SOURCE_REF = "docs/adr/0027-coupled-stigmergic-dual-loop-agent-system.md#§3@deadbee";

function fullEntry() {
  return {
    slug: "coupled-dual-loop",
    compiledTruth: [
      "# Coupled Dual Loop",
      "",
      "The system couples a fast loop and a slow loop via stigmergy.",
      "",
      "## 为何如此设计",
      "",
      "Because decoupled loops drift; the coupling keeps them coherent. See `extensions/sediment/curator.ts`.",
      "",
      "## 被拒方案",
      "",
      "A single monolithic loop was rejected — it could not scale to 200-step chains.",
    ].join("\n"),
    frontmatter: { source_ref: SOURCE_REF, direction_impact: ["supports | direction.md#INV-AUTONOMY | none"] },
    directionImpact: [{ relation: "supports", ref: "direction.md#INV-AUTONOMY", escalation: "none", raw: "supports | direction.md#INV-AUTONOMY | none" }],
    confidence: 8,
  };
}

// ─── MISSING (acceptance ⑧): never fabricate ────────────────────────────────
{
  const r = renderRationaleFromEntry("nonexistent-slug", null);
  assert(r.found === false, "missing: found=false");
  assert(/Do NOT fabricate/.test(r.missingMessage || ""), "missing: explicit no-fabrication message");
  assert(r.whyDesigned === undefined && r.shortAnswer === undefined, "missing: no fabricated content");
  assert(r.directionImpact.length === 0, "missing: no direction_impact");
  const text = formatRationale(r);
  assert(/git history/.test(text) && /docs\/adr/.test(text), "missing: format points to git/docs/code");
  assert(!/为何如此设计/.test(text), "missing: format has no invented design narrative");
}

// ─── FOUND: only formats stored data ────────────────────────────────────────
{
  const e = fullEntry();
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.found === true, "found: found=true");
  assert(typeof r.whyDesigned === "string" && /coherent/.test(r.whyDesigned), "found: whyDesigned from WHY section");
  assert(/monolithic loop was rejected/.test(r.rejectedAlternatives || ""), "found: rejectedAlternatives extracted");
  assert(r.directionImpact.length === 1 && r.directionImpact[0].relation === "supports", "found: direction_impact carried");
  assert(r.evidence.sourceRef === SOURCE_REF, "found: pinned source_ref surfaced (revision #8)");
  assert(r.evidence.codeSymbols.includes("extensions/sediment/curator.ts"), "found: code symbol extracted (grounded)");
  assert(r.confidence === 8, "found: confidence carried");
  // GROUNDING: shortAnswer is a literal substring of the stored body (not invented)
  assert(e.compiledTruth.includes(r.shortAnswer), "found: shortAnswer is grounded substring of body");
  const text = formatRationale(r);
  assert(text.includes(SOURCE_REF), "found: format surfaces pinned SHA");
  assert(/置信与缺口/.test(text), "found: format has confidence/gaps section");
}

// ─── FOUND but missing pieces → honest gaps, not invention ──────────────────
{
  const e = fullEntry();
  delete e.frontmatter.source_ref;
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.evidence.sourceRef === undefined, "no-source_ref: sourceRef undefined");
  assert(r.gaps.some((g) => /no source_ref/.test(g)), "no-source_ref: gap reported");
  assert(/no pinned SHA/.test(formatRationale(r)), "no-source_ref: format flags missing SHA");
}
{
  const e = fullEntry();
  e.compiledTruth = "# Title\n\nThe system couples loops via stigmergy and keeps them coherent.";
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.rejectedAlternatives === undefined, "no-rejected: rejectedAlternatives undefined");
  assert(r.gaps.some((g) => /rejected alternatives not recorded/.test(g)), "no-rejected: gap reported");
  assert(/not recorded in abrain/.test(formatRationale(r)), "no-rejected: format honest about gap");
}
{
  const e = fullEntry();
  e.compiledTruth = "";
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.whyDesigned === undefined, "empty-body: no whyDesigned");
  assert(r.gaps.some((g) => /no compiled rationale body/.test(g)), "empty-body: gap reported");
}

// ─── FOUND via raw frontmatter direction_impact (parser fallback) ───────────
{
  const e = fullEntry();
  delete e.directionImpact; // simulate entry without pre-parsed field
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.directionImpact.length === 1 && r.directionImpact[0].ref === "direction.md#INV-AUTONOMY", "fallback: direction_impact parsed from frontmatter");
}
{
  // low confidence → gap
  const e = fullEntry();
  e.confidence = 3;
  const r = renderRationaleFromEntry(e.slug, e);
  assert(r.gaps.some((g) => /low confidence/.test(g)), "low-conf: gap reported");
}

// ─── async renderRationale with injected resolver ───────────────────────────
{
  const e = fullEntry();
  const r1 = await renderRationale(e.slug, async () => e);
  assert(r1.found === true && r1.slug === e.slug, "async: resolver returns entry → found");
  const r2 = await renderRationale("gone", async () => null);
  assert(r2.found === false, "async: resolver returns null → missing");
  const r3 = await renderRationale("boom", async () => { throw new Error("db down"); });
  assert(r3.found === false, "async: resolver throws → missing (never fabricate)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`smoke:rationale OK (${passed} assertions)`);
