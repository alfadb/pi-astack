#!/usr/bin/env node
/**
 * smoke-adr-readme-anchors — lock that docs/adr/README.md only points to
 * ADR files that actually exist + only references invariant / section
 * names that haven't been silently renamed.
 *
 * README.md is a navigation index (zero original content, all link).
 * Its value depends on its anchors being live; a dangling anchor turns
 * the README from "indexed truth" into "broken treasure map". This
 * smoke catches drift between README anchors and ADR file structure.
 *
 * What this asserts:
 *   1. Every ./00NN-foo.md reference resolves to a real file in
 *      docs/adr/
 *   2. Every #section-anchor exists as a heading in the referenced
 *      ADR file (markdown auto-generated anchor convention)
 *   3. README.md does NOT contain original design-statement text —
 *      defensive against future drift where someone copies ADR
 *      content into README (which would create duplicate-truth
 *      maintenance burden, the exact thing README form rejects)
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const readmePath = path.join(repoRoot, "docs/adr/README.md");
const adrDir = path.join(repoRoot, "docs/adr");

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`);
  }
}

console.log("\n[1] README.md exists + is a file");
check("README.md exists", fs.existsSync(readmePath));
check("README.md is a file", fs.statSync(readmePath).isFile());

const readme = fs.readFileSync(readmePath, "utf-8");

console.log("\n[2] All ADR file references resolve");
// Match ./00NN-foo.md (relative-to-adr-dir form used in README)
const fileRefs = Array.from(readme.matchAll(/\.\/(0\d{3}-[a-z0-9-]+\.md)/g))
  .map((m) => m[1]);
const uniqueFiles = Array.from(new Set(fileRefs));
check(`${uniqueFiles.length} unique ADR file references found`, uniqueFiles.length >= 12);
for (const f of uniqueFiles) {
  const full = path.join(adrDir, f);
  check(`  exists: ${f}`, fs.existsSync(full));
}

console.log("\n[3] All #section-anchors point at sections that exist by token-overlap");
// GFM anchor generation rules vary across renderers (GitHub / vscode
// preview / pandoc / etc.); writing a precise re-implementation here
// is brittle. Instead: extract the leading section identifier from each
// anchor (e.g. '5.1' / 'c3' / 'inv-invisibility') and check that the
// referenced ADR file has *some* heading containing it. This catches
// the real drift mode (anchor points at a renamed/deleted section)
// without falsely failing on rendering-rule edge cases.
function extractAnchorPrefix(anchor) {
  // Try to grab a leading numbered prefix (e.g. "51", "c1", "43") and
  // also keep one strong content token after it. Returns array of
  // candidates to look for in heading text.
  const candidates = [];
  // numeric section like 51-foo → "5.1" + "foo"
  const numMatch = /^(\d)(\d)-/.exec(anchor);
  if (numMatch) candidates.push(`${numMatch[1]}.${numMatch[2]}`);
  const num2Match = /^(\d)-/.exec(anchor);
  if (num2Match) candidates.push(`${num2Match[1]}.`);
  // letter-prefix like c1- / c6-
  const letterMatch = /^([a-z])(\d)-?/.exec(anchor);
  if (letterMatch) {
    const code = `${letterMatch[1].toUpperCase()}${letterMatch[2]}`;
    candidates.push(`${code}'`);   // C1' (apostrophe)
    candidates.push(`${code}、`); // C1、 (Chinese comma)
    candidates.push(`${code} `);   // C1<space>
    candidates.push(`${code}（`); // C1（ (Chinese open paren — e.g. "C6（新）")
    candidates.push(code);          // bare C1
  }
  // inv- prefix
  if (anchor.startsWith("inv-")) candidates.push("INV-");
  return candidates;
}

const linksWithAnchors = Array.from(
  readme.matchAll(/\.\/(0\d{3}-[a-z0-9-]+\.md)#([^\s)]+)/g),
);
const byFile = new Map();
for (const m of linksWithAnchors) {
  const file = m[1];
  const anchor = m[2];
  if (!byFile.has(file)) byFile.set(file, new Set());
  byFile.get(file).add(anchor);
}

let totalAnchors = 0;
let resolvedAnchors = 0;
const unresolved = [];
for (const [file, anchors] of byFile) {
  const fullPath = path.join(adrDir, file);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, "utf-8");
  const headings = Array.from(content.matchAll(/^#+\s+(.+)$/gm)).map((m) => m[1].trim());
  for (const anchor of anchors) {
    totalAnchors++;
    const candidates = extractAnchorPrefix(anchor);
    // anchor 'resolves' if at least one candidate prefix appears at the
    // start of some heading
    let resolved = false;
    for (const cand of candidates) {
      if (headings.some((h) => h.includes(cand))) {
        resolved = true;
        break;
      }
    }
    // fallback: if no prefix-matching strategy works, try if any heading
    // contains a token from the anchor's tail (signal that section text
    // hasn't been renamed away from anchor's keywords)
    if (!resolved && candidates.length === 0) {
      const tail = anchor.split("-").slice(-2).filter((t) => t.length >= 3);
      if (tail.some((t) => headings.some((h) => h.toLowerCase().includes(t)))) {
        resolved = true;
      }
    }
    if (resolved) {
      resolvedAnchors++;
    } else {
      unresolved.push(`${file}#${anchor}`);
    }
  }
}
check(
  `${resolvedAnchors}/${totalAnchors} anchors point at live section markers`,
  resolvedAnchors === totalAnchors,
  unresolved.length > 0 ? `unresolved: ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ` (+${unresolved.length - 5} more)` : ""}` : "",
);

console.log("\n[4] README.md contains only navigation, no original design statements");
// Heuristic: README MUST contain certain navigation markers + MUST NOT
// re-define invariants (i.e. shouldn't have its own prose explaining
// what INV-INVISIBILITY means). Easy proxy: README is short (lines).
const readmeLines = readme.split("\n").length;
check(`README is ≤300 lines (currently ${readmeLines})`, readmeLines <= 300, "navigation index must stay short");
check("README cites ADR 0024-0027 (the 4 core ADRs)",
  readme.includes("0024-second-brain-from-natural-conversation") &&
  readme.includes("0025-sediment-meta-curator-subsystem") &&
  readme.includes("0026-second-brain-decision-participation") &&
  readme.includes("0027-coupled-stigmergic-dual-loop-agent-system"));
check("README explicitly disclaims original content",
  readme.includes("不复述") || readme.includes("零原创") || readme.includes("指路牌"));
check("README lists 4 invariants by name",
  readme.includes("INV-INVISIBILITY") &&
  readme.includes("INV-AUTONOMY") &&
  readme.includes("INV-IMPLICIT-GROUND-TRUTH") &&
  readme.includes("INV-ACTIVE-CORRECTION"));

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log("FAILURES — investigate before commit");
  process.exit(1);
}
process.exit(0);
