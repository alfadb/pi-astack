/**
 * Volatile-suffix protocol (prompt prefix-cache partition).
 *
 * Anthropic prompt caching keys by PREFIX: the cache stays valid up to the
 * first byte that differs from the cached prompt. Any block whose content
 * changes per-turn (goal status, path-A memory recall) or per-minute (wall
 * clock) must therefore sit AFTER every session-stable block, otherwise it
 * busts the cache for everything that follows it.
 *
 * The before_agent_start injectors run in extension load order (alphabetical
 * by directory), so a volatile injector cannot reorder itself relative to a
 * stable injector that loads later (e.g. `goal` < `memory` < `model-curator`
 * < `sediment` < `time-injector`). Instead, every volatile injector WRAPS its
 * block with the markers below, and the last-running injector
 * (`time-injector`) calls hoistVolatileSuffix to move all wrapped blocks to
 * the end before appending its own (always-last) time block.
 *
 * Result ordering: [all stable blocks ...][wrapped volatile blocks ...][time].
 * The stable prefix is then byte-identical across turns regardless of which
 * volatile blocks were present or what they contained.
 */

export const VOLATILE_SUFFIX_BEGIN = "<!-- pi-astack:volatile-suffix -->";
export const VOLATILE_SUFFIX_END = "<!-- /pi-astack:volatile-suffix -->";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Consume surrounding blank lines so removing a wrapped block restores the
// exact "\n\n" seam a no-block turn would have had (prefix byte-identity).
// \r? makes it robust to CRLF although the system is \n-only today.
const VOLATILE_RE = new RegExp(
  `(?:\\r?\\n)*${escapeRegex(VOLATILE_SUFFIX_BEGIN)}([\\s\\S]*?)${escapeRegex(VOLATILE_SUFFIX_END)}(?:\\r?\\n)*`,
  "g",
);

// Neutralize any literal volatile-suffix marker that appears INSIDE block
// content (e.g. a path-A memory excerpt that happens to quote this very
// protocol). Without this, hoist's non-greedy regex would stop at the first
// embedded END marker and mis-slice, leaking volatile text into the stable
// prefix. The escaped form stays a harmless HTML comment and is never
// un-escaped (it only needs to differ from the real markers).
function sanitizeMarkers(block: string): string {
  return block
    .split(VOLATILE_SUFFIX_BEGIN)
    .join("<!-- pi-astack:volatile-suffix(escaped) -->")
    .split(VOLATILE_SUFFIX_END)
    .join("<!-- pi-astack:/volatile-suffix(escaped) -->");
}

/** Wrap a per-turn / per-minute volatile block for later hoisting. */
export function wrapVolatile(block: string): string {
  return `${VOLATILE_SUFFIX_BEGIN}\n${sanitizeMarkers(block)}\n${VOLATILE_SUFFIX_END}`;
}

/**
 * Move every volatile-wrapped block to the END of the prompt, preserving
 * their relative order; drop empty/orphan wrappers (e.g. left behind when a
 * stale goal block is stripped by its own injector). Idempotent: hoisting an
 * already-hoisted prompt returns the same string. The caller (time-injector)
 * appends the time block AFTER this, so time stays strictly last.
 */
export function hoistVolatileSuffix(prompt: string): string {
  const blocks: string[] = [];
  const stripped = prompt.replace(VOLATILE_RE, (_m, inner: string) => {
    const trimmed = String(inner).trim();
    if (trimmed.length > 0) blocks.push(trimmed);
    return "\n\n";
  });
  const head = stripped.replace(/\n+$/, "");
  // Both branches end the head with the same "\n\n" seam so the function's
  // output prefix is self-consistent whether or not a volatile block was
  // present (time-injector also normalizes, but the invariant should not
  // depend on the caller).
  if (blocks.length === 0) return `${head}\n\n`;
  const tail = blocks
    .map((b) => `${VOLATILE_SUFFIX_BEGIN}\n${b}\n${VOLATILE_SUFFIX_END}`)
    .join("\n\n");
  return `${head}\n\n${tail}\n`;
}
