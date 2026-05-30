#!/usr/bin/env node
/**
 * smoke-verify-after-edit — verify the verify-after-edit extension's pure
 * buildVerificationBlock() across the documented edge cases.
 *
 * Strategy: load the .ts via jiti, call buildVerificationBlock directly
 * with controlled inputs (tmp files). No pi runtime needed since the
 * extension's tool_result handler is a thin wrapper around the pure builder.
 *
 * Asserted behavior (matches the JSDoc contract in the .ts):
 *   1. fcl=undefined  → "NOTE: empty diff — file unchanged."
 *   2. Normal file    → window with marker `►` on firstChangedLine
 *   3. ENOENT         → "file gone after edit: <path>"
 *   4. Binary file    → "file is binary — verification window skipped."
 *   5. Long line      → truncated to MAX_LINE chars + "…"
 *   6. fcl near top   → startLine clamps to 1 (no negative line numbers)
 *   7. fcl near EOF   → endLine clamps to actual file length
 *   8. Wrapping tags  → always begin/end with <verified-on-disk>...</...>
 *
 * Exit 0 on all green; exit 1 if any check fails.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const mod = jiti(path.join(repoRoot, "extensions/verify-after-edit/index.ts"));
const { buildVerificationBlock, BEGIN_TAG, END_TAG, MAX_LINE } = mod.__TEST;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vae-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function writeFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── 1. fcl=undefined → empty-diff note ────────────────────────────────
console.log("[1] fcl=undefined → empty-diff note");
{
  const out = await buildVerificationBlock("/some/path.ts", undefined);
  check("wraps with begin tag", out.startsWith(BEGIN_TAG + "\n"));
  check("wraps with end tag", out.endsWith("\n" + END_TAG));
  check("contains 'empty diff' marker", out.includes("NOTE: empty diff"));
  check("does NOT attempt to read", !out.includes("read error"));
}

// ── 2. Normal file → window with ► marker ─────────────────────────────
console.log("[2] Normal file → window with ► marker");
{
  const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
  const p = writeFile("normal.txt", lines);
  const out = await buildVerificationBlock(p, 10);
  check("contains firstChangedLine=10", out.includes("firstChangedLine=10"));
  check("declares window range", /lines 7–22 shown/.test(out));
  check("has ► marker on line 10", out.includes("► " + p + ":10: line10"));
  check("has space marker on adjacent line 11", out.includes("  " + p + ":11: line11"));
  check("uses fenced code block", /```\n[\s\S]+\n```/.test(out));
  check("contains line 7 (start of window)", out.includes(":7: line7"));
  check("contains line 22 (end of window)", out.includes(":22: line22"));
  check("does NOT contain line 6 (before window)", !out.includes(":6: line6"));
  check("does NOT contain line 23 (after window)", !out.includes(":23: line23"));
}

// ── 3. ENOENT → file-gone note ────────────────────────────────────────
console.log("[3] ENOENT → file-gone note");
{
  const p = path.join(tmpDir, "nonexistent.txt");
  const out = await buildVerificationBlock(p, 5);
  check("contains 'file gone' marker", out.includes("file gone after edit"));
  check("contains the offending path", out.includes(p));
  check("does NOT contain firstChangedLine line", !out.includes("firstChangedLine="));
}

// ── 4. Binary file → binary-skipped note ──────────────────────────────
console.log("[4] Binary file → binary-skipped note");
{
  const p = writeFile("binary.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  const out = await buildVerificationBlock(p, 1);
  check("contains 'is binary' marker", out.includes("file is binary"));
  check("does NOT include hex content", !out.includes("0x89"));
}

// ── 5. Long line → truncated to MAX_LINE + "…" ────────────────────────
console.log("[5] Long line truncation");
{
  const longLine = "x".repeat(MAX_LINE + 50);
  const p = writeFile("long.txt", `header\n${longLine}\nfooter`);
  const out = await buildVerificationBlock(p, 2);
  // Body line should be exactly MAX_LINE x's followed by "…"
  check("truncated marker '…' present", out.includes("…"));
  // The full untruncated long line should NOT appear in the output
  check("full long line NOT present", !out.includes("x".repeat(MAX_LINE + 1) + "x"));
  // The truncated portion should be present
  check("truncated x*MAX_LINE present", out.includes("x".repeat(MAX_LINE) + "…"));
}

// ── 6. fcl near top → startLine clamps to 1 ───────────────────────────
console.log("[6] fcl near top (line 1)");
{
  // 20-line file so the trailing window (fcl+12=13) does NOT itself get
  // clamped — we are verifying the LEADING clamp here, isolated.
  const lines = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join("\n");
  const p = writeFile("top.txt", lines);
  const out = await buildVerificationBlock(p, 1);
  // startLine = max(1, 1-3) = 1; endLine = min(20, 1+12) = 13.
  check("startLine clamps to 1", /lines 1–13 shown/.test(out));
  check("► on line 1", out.includes("► " + p + ":1: r1"));
  check("no negative line numbers", !out.includes(":-") && !out.includes(":0:"));
}

// ── 7. fcl near EOF → endLine clamps to file length ───────────────────
console.log("[7] fcl near EOF");
{
  const lines = Array.from({ length: 5 }, (_, i) => `e${i + 1}`).join("\n");
  const p = writeFile("eof.txt", lines);
  const out = await buildVerificationBlock(p, 5);
  // startLine = max(1, 5-3) = 2; endLine = min(5, 5+12) = 5
  check("endLine clamps to 5", /lines 2–5 shown/.test(out));
  check("► on line 5", out.includes("► " + p + ":5: e5"));
  check("does NOT reference line 6+", !out.includes(":6:") && !out.includes(":17:"));
}

// ── 8. Always wraps with verified-on-disk tags ────────────────────────
console.log("[8] Tag wrapping invariant");
{
  for (const [name, fcl, mkPath] of [
    ["empty", undefined, () => "/x"],
    ["normal", 1, () => writeFile("wrap.txt", "a\nb\nc")],
    ["enoent", 5, () => path.join(tmpDir, "noexist.xx")],
  ]) {
    const out = await buildVerificationBlock(mkPath(), fcl);
    check(`${name}: starts with ${BEGIN_TAG}`, out.startsWith(BEGIN_TAG));
    check(`${name}: ends with ${END_TAG}`, out.endsWith(END_TAG));
  }
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (fail > 0) {
  process.exit(1);
}
process.exit(0);
