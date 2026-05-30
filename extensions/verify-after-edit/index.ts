/**
 * verify-after-edit — append the on-disk verification window to every
 * successful `edit` tool_result so the model sees the post-edit state in
 * the very next turn's context.
 *
 * ## Why this extension
 *
 * pi's built-in `edit` tool returns a one-line confirmation on success:
 *   "Successfully replaced N block(s) in <path>."
 * The LLM-visible content does NOT include the actual on-disk state after
 * the edit. This creates a class of failures where the model:
 *   - assumes its edit landed exactly as written and proceeds
 *   - or hallucinates a follow-on read result
 *   - or batches more edits/commits before verifying
 *
 * Concrete dogfood incidents (2026-05-30 session): multiple Opus 4.8 batches
 * of edits[] failed atomically (one oldText mismatch → whole batch rolled
 * back), but the success line from a DIFFERENT successful edit in the same
 * burst was carried forward, the model assumed all edits landed, and
 * proceeded to commit + push commits that referenced changes never on disk.
 *
 * This extension structurally closes that loop: after each successful
 * `edit`, we read the file at the changed location and APPEND a window
 * (firstChangedLine ± a few lines) to the tool_result content. The model's
 * next-turn context now carries verified disk truth alongside the success
 * line. It cannot "forget" to re-read because the read has already happened
 * and is sitting in plain sight.
 *
 * ## Why tool_result hook, not a wrapping tool
 *
 * `tool_result` is the public extension API and fires for built-in `edit`
 * after its own execute returns. Returning `{ content }` replaces the
 * LLM-visible content array (we spread the original and append). No need
 * to register a custom tool, no need to delegate to builtin internals, no
 * need to touch pi source. Pure additive.
 *
 * ## Why sub-agents also get this
 *
 * Sub-agents (dispatch_parallel workers) also benefit from post-edit
 * verification — they often write reports / files and the same "claim
 * success without verifying" pattern applies. No isSubAgentSession guard.
 *
 * ## Window choice (W_BEFORE/W_AFTER/MAX_LINE)
 *
 * - 3 lines before + 12 after the firstChangedLine = 16 lines max
 * - each line capped at 200 chars (minified-JS / huge-line safety)
 * - worst case ~3.2 KB injected text per edit → negligible token cost
 *
 * For multi-hunk edits, only the FIRST changed location is verified (pi
 * only exposes `firstChangedLine` in EditToolDetails). A future improvement
 * could parse `details.patch` for all hunk headers and union windows.
 *
 * ## Edge cases handled
 *
 * - `firstChangedLine === undefined` (empty diff = no real change) → emit
 *   a short "NOTE: empty diff" instead of reading
 * - file no longer exists post-edit (rm in same turn) → emit "file gone"
 * - file became binary (race with another writer) → emit "binary, skipped"
 * - very long lines → truncated to MAX_LINE with "…"
 * - read failure (permissions etc) → emit error string
 *
 * The hook is async but cannot abort the tool result — worst case our
 * read fails and we emit an explanatory message. We never throw out of
 * the handler.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

const W_BEFORE = 3;
const W_AFTER = 12;
const MAX_LINE = 200;
// Hot-path guard (3-T0 P2): never slurp a huge post-edit file into a UTF-8
// string just to show a 16-line window. Above this size we emit a note.
const MAX_VERIFY_BYTES = 5 * 1024 * 1024;

const BEGIN_TAG = "<verified-on-disk>";
const END_TAG = "</verified-on-disk>";

/**
 * Build the verification block to append to a successful edit's content.
 * Pure function — exported for unit-test coverage by smoke.
 *
 * @param filePath   Path passed to the edit tool (relative or absolute).
 * @param fcl        `firstChangedLine` from EditToolDetails, or undefined.
 *                   1-indexed per pi's convention.
 */
export async function buildVerificationBlock(
  filePath: string,
  fcl: number | undefined,
): Promise<string> {
  const wrap = (body: string) => `${BEGIN_TAG}\n${body}\n${END_TAG}`;

  if (fcl === undefined) {
    return wrap("NOTE: empty diff — file unchanged.");
  }

  // Size guard BEFORE reading: stat is O(1); a multi-MB post-edit file (or
  // one another process grew) must not be slurped into a UTF-8 string for a
  // 16-line window (3-T0 P2). Also catches ENOENT cheaply.
  try {
    const st = await stat(filePath);
    if (st.size > MAX_VERIFY_BYTES) {
      return wrap(
        `file too large to window (${st.size} bytes > ${MAX_VERIFY_BYTES}); ` +
          `edit succeeded, verification window skipped.`,
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return wrap(`file gone after edit: ${filePath}`);
    // Other stat errors: fall through and let readFile surface the reason.
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return wrap(`file gone after edit: ${filePath}`);
    return wrap(`read error: ${String(err)}`);
  }

  // Cheap binary detection: scan first 512 bytes for a null byte.
  if (raw.slice(0, 512).includes("\0")) {
    return wrap("file is binary — verification window skipped.");
  }

  const lines = raw.split("\n");
  const startLine = Math.max(1, fcl - W_BEFORE);
  const endLine = Math.min(lines.length, fcl + W_AFTER);

  const body = lines
    .slice(startLine - 1, endLine)
    .map((line, i) => {
      const n = startLine + i;
      const text = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
      const marker = n === fcl ? "►" : " ";
      return `${marker} ${filePath}:${n}: ${text}`;
    })
    .join("\n");

  return wrap(
    `firstChangedLine=${fcl} (lines ${startLine}–${endLine} shown)\n` +
      "```\n" +
      body +
      "\n```",
  );
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_VERIFY_AFTER_EDIT === "1") return;

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit") return;
    if (event.isError) return; // edit failed; nothing to verify

    const input = event.input as { path?: unknown } | undefined;
    const rawPath = typeof input?.path === "string" ? input.path : undefined;
    if (!rawPath) return; // defensive: missing path → skip

    // 3-T0 P0/P1: the builtin edit tool resolves relative paths against the
    // SESSION cwd (ctx.cwd), not process.cwd(). Reading input.path directly
    // (Node resolves vs process.cwd()) would, when the two diverge, read a
    // DIFFERENT file and present it as <verified-on-disk> truth — inverting
    // this extension's purpose. Resolve against ctx.cwd exactly like the
    // builtin (and like edit-strip-empty's execute override already does).
    const cwd = typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string"
      ? (ctx as { cwd: string }).cwd
      : process.cwd();
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    const details = event.details as { firstChangedLine?: number } | undefined;
    const fcl = typeof details?.firstChangedLine === "number" ? details.firstChangedLine : undefined;

    const block = await buildVerificationBlock(filePath, fcl);

    // Defensive (3-T0 P2): event.content is typed as an array, but spreading
    // a non-array (if some upstream handler replaced it) would corrupt the
    // result. Guard before spreading.
    const prior = Array.isArray(event.content) ? event.content : [];
    return {
      content: [
        ...prior, // preserve "Successfully replaced N block(s) in <path>."
        { type: "text" as const, text: block },
      ],
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Test-only exports
// ──────────────────────────────────────────────────────────────────────

export const __TEST = {
  W_BEFORE,
  W_AFTER,
  MAX_LINE,
  BEGIN_TAG,
  END_TAG,
  buildVerificationBlock,
};
