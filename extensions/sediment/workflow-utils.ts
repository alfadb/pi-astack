/**
 * workflow-utils — shared workflow-lane detection used by BOTH the
 * curator and the multi-view reviewer.
 *
 * Extracted from curator.ts (commit b575eab → next) to break a value-level
 * circular dependency that the multi-view reviewer integration introduced:
 *
 *   curator.ts          imports { runMultiView } from "./multi-view"
 *   multi-view.ts       imports { isWorkflowNeighborEntry } from "./curator"
 *
 * In Node.js CommonJS resolution, that loop returns a partially-initialized
 * `curator` exports object to multi-view.ts at module-load time; the
 * `isWorkflowNeighborEntry` symbol is only filled in later when curator.ts
 * has finished evaluating top-to-bottom. The function happens to be called
 * only from runtime function bodies (renderNeighbors / synthesizeFromPass1),
 * so the symbol IS bound by the time real calls land — but this relies on
 * undefined behavior in CJS module init order and would break under ESM
 * or under bundlers that hoist differently.
 *
 * Putting the detector here keeps the curator.ts → multi-view.ts edge
 * one-directional. multi-view.ts no longer reaches back into curator.ts.
 *
 * Smoke tests (smoke-memory-sediment.mjs ~entry 1320) historically imported
 * `isWorkflowNeighborEntry` from "./curator"; that re-export is preserved
 * in curator.ts so smoke does not need to change.
 *
 * The detector's contract is unchanged from its curator.ts origin —
 * preserved verbatim including all comments / defensive checks. Future
 * refactors of workflow-lane semantics happen here, not in curator.ts.
 */

import * as path from "node:path";
import type { MemoryEntry } from "../memory/types";

/**
 * Heuristic detector for workflow-lane entries. Workflow entries live in
 * `~/.abrain/[projects/<id>/]workflows/<slug>.md`. They are produced and
 * mutated by a SEPARATE writer (`writeAbrainWorkflow`, B1) and the regular
 * sediment auto-write path (`updateProjectEntry` / `supersedeProjectEntry`
 * / `deleteProjectEntry`) explicitly skips the `workflows/` subdir when
 * resolving target files (see extensions/sediment/writer.ts::findProjectEntryFile).
 *
 * However, the read side (memory parser → llmSearchEntries → curator
 * neighbor pool) DOES surface workflow entries, with `scope` collapsed to
 * `project` (or `world` for cross-project ones) because `Scope` only has
 * those two values. That asymmetry caused real `entry_not_found` rejections
 * in production (2026-05-19 sub2api audit row 32: curator chose op=update
 * slug=run-when-releasing, writer scanned `~/.abrain/projects/sub2api/`
 * minus `workflows/`, found nothing, rejected as entry_not_found — the
 * candidate's claim was silently dropped instead of merging into the
 * workflow or becoming a new derived knowledge entry).
 *
 * Detection signals (OR; the writer-side ground truth is the path, but we
 * also accept frontmatter markers for robustness against future store
 * layout changes):
 *   1. `frontmatter.scope === "workflow"` (canonical declaration; B1 writer
 *      emits this).
 *   2. `legacyKind === "workflow"` (parser.ts::normalizeKind preserves the
 *      raw `kind: workflow` here because "workflow" is not in ENTRY_KINDS).
 *   3. sourcePath contains a `/workflows/` segment (mechanical fallback).
 *
 * Exported for smoke (smoke-memory-sediment.mjs ~entry 1320) so future
 * refactors that move the workflow store do not silently regress the
 * curator-side read/write asymmetry guard.
 */
export function isWorkflowNeighborEntry(entry: MemoryEntry): boolean {
  const fmScope = entry.frontmatter && typeof (entry.frontmatter as any).scope === "string"
    ? String((entry.frontmatter as any).scope).trim()
    : "";
  if (fmScope === "workflow") return true;
  if (entry.legacyKind === "workflow") return true;
  // 2026-05-19 round-2 review (Opus P2-1): scope the path probe to the
  // entry's storeRoot so an ancestor directory literally named
  // "workflows" (e.g. $HOME=/var/workflows/alice or a worktree clone
  // placed under a path with that segment) cannot falsely tag every
  // entry as workflow-lane. The writer-side invariant (writer.ts:347-360,
  // findProjectEntryFile skips `entry.name === "workflows"` during the
  // store-rooted recursion) is exactly "first relative segment under
  // storeRoot is `workflows`". Mirror that invariant here.
  //
  // Fallback when storeRoot is missing (shouldn't happen for parsed
  // entries — parser.ts always sets it — but mock entries in tests
  // and any future caller-constructed MemoryEntry could omit it):
  // refuse to detect via path. Frontmatter signals 1+2 are still active.
  if (entry.storeRoot) {
    const rel = path.relative(entry.storeRoot, entry.sourcePath);
    // path.relative returns an absolute path or ".."-prefixed string
    // when sourcePath escapes storeRoot — reject those rather than
    // matching a `workflows` segment outside the store boundary.
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const firstSeg = rel.split(/[\\/]+/)[0];
      if (firstSeg === "workflows") return true;
    }
  }
  return false;
}
