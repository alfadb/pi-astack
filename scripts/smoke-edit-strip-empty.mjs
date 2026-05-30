#!/usr/bin/env node
/**
 * smoke-edit-strip-empty — verify the edit-strip-empty extension's pure
 * helpers (isEmpty / stripEmptyPhantoms) and the full prepareArguments
 * chain against documented edge cases.
 *
 * What this asserts:
 *   1. isEmpty() classifies null/undefined/""/whitespace/[]/{}/ as empty
 *      and 0/false/NaN/"x"/[1]/{a:1} as NOT empty.
 *   2. stripEmptyPhantoms() deletes empty unknown fields at top-level
 *      AND per-edit, while leaving non-empty unknowns intact (schema
 *      will reject those later — the loud-failure path).
 *   3. Allow-listed keys (path/edits at top; oldText/newText per edit)
 *      are NEVER deleted even when empty.
 *   4. Mixed payloads work (empty + non-empty unknowns coexist).
 *   5. Non-object inputs are passed through unchanged.
 *   6. Builtin createEditToolDefinition is importable from the top-level
 *      pi-coding-agent ESM entry (public API contract probe).
 *   7. Chained prepareArguments: builtin's legacy-shape handler
 *      (edits-as-JSON-string) runs before our strip, and our strip works
 *      on the parsed result.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

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

const ext = jiti(path.join(repoRoot, "extensions/edit-strip-empty/index.ts"));
const { isEmpty, stripEmptyPhantoms, KEEP_TOP_LEVEL, KEEP_EDIT_ITEM } = ext.__TEST;

// ─── 1. isEmpty classifications ─────────────────────────────────────
console.log("[1] isEmpty()");
{
  // Empty:
  check("null is empty", isEmpty(null));
  check("undefined is empty", isEmpty(undefined));
  check('"" is empty', isEmpty(""));
  check('"   " (whitespace) is empty', isEmpty("   "));
  check('"\\t\\n" (mixed whitespace) is empty', isEmpty("\t\n"));
  check("[] is empty", isEmpty([]));
  check("{} is empty", isEmpty({}));

  // NOT empty (could be real values):
  check("0 is NOT empty", !isEmpty(0));
  check("false is NOT empty", !isEmpty(false));
  check("NaN is NOT empty", !isEmpty(NaN));
  check('"x" is NOT empty', !isEmpty("x"));
  check('"  x  " (padded) is NOT empty', !isEmpty("  x  "));
  check("[1] is NOT empty", !isEmpty([1]));
  check("{a:1} is NOT empty", !isEmpty({ a: 1 }));
  check("number 1 is NOT empty", !isEmpty(1));
}

// ─── 2. stripEmptyPhantoms top-level ────────────────────────────────
console.log("[2] stripEmptyPhantoms — top-level");
{
  const a = { path: "x", edits: [], newText2: "" };
  stripEmptyPhantoms(a);
  check("empty newText2 at top is deleted", !("newText2" in a));
  check("path preserved", a.path === "x");
  check("edits preserved", Array.isArray(a.edits));

  const b = { path: "x", edits: [], comment: "I meant to add this" };
  stripEmptyPhantoms(b);
  check("non-empty comment at top is KEPT (schema will reject)", b.comment === "I meant to add this");

  const c = { path: "x", edits: [], lineNumber: 0 };
  stripEmptyPhantoms(c);
  check("lineNumber=0 at top is KEPT (0 is real)", c.lineNumber === 0);

  const d = { path: "x", edits: [], hint: null, note: undefined, payload: [] };
  stripEmptyPhantoms(d);
  check("null deleted at top", !("hint" in d));
  check("undefined deleted at top", !("note" in d));
  check("empty array deleted at top", !("payload" in d));
}

// ─── 3. stripEmptyPhantoms per-edit ─────────────────────────────────
console.log("[3] stripEmptyPhantoms — per-edit");
{
  const a = {
    path: "x",
    edits: [{ oldText: "a", newText: "b", newText2: "" }],
  };
  stripEmptyPhantoms(a);
  check("per-edit empty newText2 deleted", !("newText2" in a.edits[0]));
  check("oldText preserved", a.edits[0].oldText === "a");
  check("newText preserved", a.edits[0].newText === "b");

  const b = {
    path: "x",
    edits: [{ oldText: "a", newText: "b", newText2: "real content" }],
  };
  stripEmptyPhantoms(b);
  check("per-edit NON-empty newText2 KEPT (schema will reject)", b.edits[0].newText2 === "real content");

  const c = {
    path: "x",
    edits: [{ oldText: "a", newText: "b", lineNumber: 0 }],
  };
  stripEmptyPhantoms(c);
  check("per-edit lineNumber=0 KEPT", c.edits[0].lineNumber === 0);

  // Multiple edits, mixed
  const d = {
    path: "x",
    edits: [
      { oldText: "a", newText: "b", newText2: "" },
      { oldText: "c", newText: "d", newText3: null },
      { oldText: "e", newText: "f", lineNumber: 42 },
    ],
  };
  stripEmptyPhantoms(d);
  check("edits[0]: empty stripped", !("newText2" in d.edits[0]));
  check("edits[1]: null stripped", !("newText3" in d.edits[1]));
  check("edits[2]: non-empty number 42 KEPT", d.edits[2].lineNumber === 42);
}

// ─── 4. Allow-list invariant: keep keys are NEVER stripped ──────────
console.log("[4] Allow-list invariant");
{
  // Even if path or edits is empty, they MUST be preserved (schema will
  // reject empty path / non-array edits, but it's not our job to gate
  // those — they go through to the loud failure path).
  const a = { path: "", edits: [] };
  stripEmptyPhantoms(a);
  check('empty "" path is KEPT (schema rejects, not us)', "path" in a);
  check("empty edits[] is KEPT", "edits" in a);

  const b = { path: "x", edits: [{ oldText: "", newText: "" }] };
  stripEmptyPhantoms(b);
  check("empty oldText is KEPT per-edit", "oldText" in b.edits[0]);
  check("empty newText is KEPT per-edit", "newText" in b.edits[0]);

  check("KEEP_TOP_LEVEL = {path, edits}", KEEP_TOP_LEVEL.has("path") && KEEP_TOP_LEVEL.has("edits") && KEEP_TOP_LEVEL.size === 2);
  check("KEEP_EDIT_ITEM = {oldText, newText}", KEEP_EDIT_ITEM.has("oldText") && KEEP_EDIT_ITEM.has("newText") && KEEP_EDIT_ITEM.size === 2);
}

// ─── 5. Non-object inputs pass through ──────────────────────────────
console.log("[5] Non-object passthrough");
{
  check("null passes through", stripEmptyPhantoms(null) === null);
  check("undefined passes through", stripEmptyPhantoms(undefined) === undefined);
  check("string passes through", stripEmptyPhantoms("x") === "x");
  check("number passes through", stripEmptyPhantoms(42) === 42);
  const arr = [1, 2, 3];
  check("array passes through (no recursion)", stripEmptyPhantoms(arr) === arr && arr.length === 3);
}

// ─── 6. Public API probe: createEditToolDefinition is importable ────
console.log("[6] Public API contract probe");
{
  // jiti -> top-level pi-coding-agent (ESM-only package). The
  // edit-strip-empty extension imports createEditToolDefinition from
  // here; this probe makes sure the import stays valid across pi upgrades.
  const piEntry = await import("@earendil-works/pi-coding-agent");
  check("createEditToolDefinition is a function", typeof piEntry.createEditToolDefinition === "function");
  check("defineTool is a function", typeof piEntry.defineTool === "function");
  const proto = piEntry.createEditToolDefinition(process.cwd());
  check("proto has parameters (schema)", proto.parameters && typeof proto.parameters === "object");
  check("proto has prepareArguments", typeof proto.prepareArguments === "function");
  check("proto.name === 'edit'", proto.name === "edit");
}

// ─── 7. Chained prepareArguments with builtin's legacy-shape ────────
console.log("[7] Chained: builtin legacy-shape → our strip");
{
  const piEntry = await import("@earendil-works/pi-coding-agent");
  const proto = piEntry.createEditToolDefinition(process.cwd());
  const prep = (raw) => stripEmptyPhantoms(proto.prepareArguments(raw));

  // Case A: edits as JSON string (Opus 4.6 / GLM-5.1 shape)
  const rawA = {
    path: "x",
    edits: '[{"oldText":"a","newText":"b","newText2":""}]',
  };
  const outA = prep(rawA);
  check("A: edits parsed from JSON string", Array.isArray(outA.edits));
  check("A: empty newText2 stripped after parse", !("newText2" in outA.edits[0]));
  check("A: oldText preserved", outA.edits[0].oldText === "a");
  check("A: newText preserved", outA.edits[0].newText === "b");

  // Case B: already-correct shape with top-level empty phantom
  const rawB = {
    path: "y",
    edits: [{ oldText: "c", newText: "d" }],
    suggestedReason: "",
  };
  const outB = prep(rawB);
  check("B: empty top-level phantom stripped", !("suggestedReason" in outB));
  check("B: top-level structure preserved", outB.path === "y" && outB.edits.length === 1);

  // Case C: non-empty phantom survives chain (will hit schema rejection)
  const rawC = {
    path: "z",
    edits: [{ oldText: "x", newText: "y", actualIntent: "wrong field" }],
  };
  const outC = prep(rawC);
  check("C: non-empty per-edit phantom SURVIVES strip", outC.edits[0].actualIntent === "wrong field");
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (fail > 0) process.exit(1);
process.exit(0);
