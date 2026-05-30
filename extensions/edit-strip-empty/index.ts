/**
 * edit-strip-empty — wrap the built-in `edit` tool to silently drop
 * empty-value hallucinated properties (e.g. `newText2: ""`) BEFORE schema
 * validation, while letting non-empty hallucinated properties hit pi's
 * native schema-rejection path.
 *
 * ## Why this extension
 *
 * Issue 3 of the Opus-4.8 mechanical guardrail trio. During dogfood,
 * 4.8 frequently emits edits like:
 *
 *   { path: "x.ts", edits: [
 *     { oldText: "a", newText: "b", newText2: "" },
 *     { oldText: "c", newText: "d", newText2: "" },
 *   ] }
 *
 * pi's built-in edit schema has `additionalProperties: false` on BOTH
 * the top-level object AND each edits[] item, so the `newText2: ""`
 * gets rejected by TypeBox validation, the call fails with an
 * "additional property not allowed" error, and the turn is wasted on
 * a re-attempt. Across a long session this adds up to dozens of wasted
 * round-trips.
 *
 * ## The smart heuristic: filter by emptiness
 *
 * The user-observed pattern is that 4.8's hallucinated properties are
 * almost always EMPTY-valued. When the model has real intent, it
 * writes the intent into a real field (oldText/newText), not into a
 * phantom property. So:
 *
 *   - empty unknown property  → silent drop (zero real intent lost)
 *   - non-empty unknown       → keep, let schema reject (could be
 *                                misplaced real content → loud failure
 *                                is correct)
 *
 * This is strictly safer than a blanket whitelist-strip:
 *   - Blanket whitelist would also drop non-empty hallucinations, which
 *     could silently lose actual content the model meant to place
 *     somewhere — turning a loud failure into a silent semantic error.
 *   - Empty-only strip cannot lose real content (empty ≠ real content).
 *
 * No `tool_result` side channel is needed: drops are silent (call
 * succeeded), rejections are loud (pi's native schema-rejection message
 * already tells the model what was invalid).
 *
 * ## "Empty" definition
 *
 *   - null / undefined           → empty
 *   - "" or whitespace-only      → empty
 *   - [] (empty array)           → empty
 *   - {} (empty object)          → empty
 *   - 0 / false / NaN            → NOT empty (could be real values for
 *                                  fields like lineNumber, offset, etc.)
 *
 * The conservative stance on 0/false is intentional: if 4.8 puts
 * `lineNumber: 0` in a hallucinated field, that 0 could plausibly be
 * misplaced real intent — surfacing it via schema rejection is more
 * informative than swallowing it.
 *
 * ## Architecture
 *
 *   1. Import `createEditToolDefinition` from the public pi-coding-agent
 *      top-level export. This is the canonical builtin factory.
 *   2. Construct a `proto` builtin once at extension activation (with
 *      process.cwd() as cwd; cwd is only used by execute, never by
 *      prepareArguments / parameters / render*). Spread it into our
 *      registered tool to inherit schema, descriptions, and rendering.
 *   3. Override `prepareArguments`: stage 1 = builtin's legacy-shape
 *      compat (e.g. Opus 4.6 / GLM-5.1 sending edits as a JSON string);
 *      stage 2 = our empty-phantom strip.
 *   4. Override `execute`: construct a FRESH builtin def with the
 *      current ctx.cwd (so path resolution uses the live working
 *      directory), then delegate.
 *
 * Same name "edit" as the builtin → pi's tool registry overrides the
 * builtin with ours.
 *
 * ## What this does NOT do
 *
 * - Does not change the schema description visible to the model (we
 *   inherit it from the builtin verbatim). The model still sees
 *   "only oldText and newText" guidance, just in case.
 * - Does not surface a notice to the model when phantoms are dropped.
 *   The intent is invisibility: phantoms become a non-event, not a
 *   self-deprecating "I stripped your bad input" footnote that could
 *   add to context noise turn after turn.
 * - Does not enforce additional invariants (e.g. unique oldText, no
 *   nested overlapping edits) — those belong to the builtin's execute.
 *
 * ## Configuration
 *
 * Disable entirely: `PI_ASTACK_DISABLE_EDIT_STRIP_EMPTY=1`. The builtin
 * edit tool then resumes its native (strict-rejection) behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";

const KEEP_TOP_LEVEL = new Set(["path", "edits"]);
const KEEP_EDIT_ITEM = new Set(["oldText", "newText"]);

/**
 * Decide whether a value is "empty" = carries no real intent.
 *
 *   - null / undefined  → empty
 *   - "" / whitespace   → empty
 *   - [] / {}           → empty
 *   - 0 / false / NaN   → NOT empty (could be real values)
 *
 * Exported for smoke coverage.
 */
export function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    // Plain object check; Object.keys handles inherited-property cases
    // sensibly (we only care about own enumerable string keys).
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

/**
 * Walk `input` and delete any unknown properties (not in the allow-list)
 * whose value is empty. Mutates `input` in place AND returns it for
 * chaining convenience.
 *
 * Non-empty unknowns are intentionally LEFT IN PLACE — the strict
 * `additionalProperties: false` schema below will reject them, surfacing
 * a loud error to the model.
 *
 * Exported for smoke coverage.
 */
export function stripEmptyPhantoms<T>(input: T): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const obj = input as Record<string, unknown>;

  // Top-level unknowns
  for (const k of Object.keys(obj)) {
    if (!KEEP_TOP_LEVEL.has(k) && isEmpty(obj[k])) {
      delete obj[k];
    }
  }

  // Per-edit unknowns (only walk if edits is actually an array)
  if (Array.isArray(obj.edits)) {
    for (const e of obj.edits) {
      if (e && typeof e === "object" && !Array.isArray(e)) {
        const editObj = e as Record<string, unknown>;
        for (const k of Object.keys(editObj)) {
          if (!KEEP_EDIT_ITEM.has(k) && isEmpty(editObj[k])) {
            delete editObj[k];
          }
        }
      }
    }
  }

  return input;
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_EDIT_STRIP_EMPTY === "1") return;

  // Proto builtin: used at registration time for static fields (schema,
  // descriptions, render*). Its closured cwd (process.cwd()) is NEVER
  // exercised because:
  //   - prepareArguments doesn't use cwd
  //   - parameters / label / description / render* don't use cwd
  //   - we override execute to construct a fresh builtin per call with
  //     the live ctx.cwd
  //
  // No type annotation: let inference give the precise generic shape
  // (TObject<{path, edits}>, EditToolDetails | undefined, EditRenderState)
  // so the spread below carries proto's render* with matching variance.
  const proto = createEditToolDefinition(process.cwd());
  type EditParams = Parameters<typeof proto.execute>[1];

  pi.registerTool(
    defineTool({
      // Spread proto first → inherit schema, descriptions, renderCall,
      // renderResult, label, etc. Same name "edit" overrides the builtin.
      ...proto,

      // Override #1: prepareArguments runs BEFORE schema validation.
      // Stage 1 = builtin's legacy-shape handler (edits-as-JSON-string).
      // Stage 2 = empty-phantom strip. Non-empty unknowns fall through
      //           to schema validation → native rejection.
      prepareArguments: (raw: unknown): EditParams => {
        const stage1 = proto.prepareArguments
          ? proto.prepareArguments(raw)
          : (raw as EditParams);
        return stripEmptyPhantoms(stage1);
      },

      // Override #2: execute delegates to a fresh builtin def with the
      // CURRENT ctx.cwd (proto was constructed with process.cwd() which
      // may differ at runtime). Cheap construction (just a closure).
      execute: async (toolCallId, input, signal, onUpdate, ctx) => {
        const builtin = createEditToolDefinition(ctx.cwd);
        return builtin.execute(toolCallId, input, signal, onUpdate, ctx);
      },
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Test-only exports
// ──────────────────────────────────────────────────────────────────────

export const __TEST = {
  KEEP_TOP_LEVEL,
  KEEP_EDIT_ITEM,
  isEmpty,
  stripEmptyPhantoms,
};
