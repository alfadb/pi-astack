/**
 * time-injector extension for pi-astack — append precise local time +
 * timezone to the system prompt at every agent turn.
 *
 * ## Why this extension
 *
 * pi's upstream `core/system-prompt.js:39` only injects
 * `Current date: YYYY-MM-DD` — no hour, no minute, no timezone. Two
 * concrete pain points fall out of that:
 *
 *   1. Main session LLM can answer "today" questions but not "what time
 *      is it" without a `bash date` round-trip (wasted tool call).
 *   2. Sub-agents (dispatch-spawned) have NO bash by default. Their tool
 *      surface is read/grep/find/ls/web_x/memory_x (web_* and memory_*
 *      families; '*' avoided here so this JSDoc block does not close
 *      early on a stray asterisk-slash), so they cannot recover precise
 *      time at all — verified 2026-05-28 with a regression probe to
 *      haiku-4-5.
 *
 * Both could be "solved" by adding a get_current_time tool, but per
 * ADR 0024 AI-Native §3 ("prefer prompt engineering over mechanical
 * paths"), context injection is the right layer. A tool would:
 *   - cost token budget on every system prompt (tool-list entry)
 *   - encourage LLMs to call it every turn instead of using context
 *   - widen the future "we have a tool for every datum" anti-pattern
 *
 * Injection is cheaper, covers both main + per-session sub-agent runtimes,
 * and keeps the tool list lean.
 *
 * ## Precision = minute
 *
 * Per the lesson in memory entry
 * `timestamp-in-streamsimple-calls-is-dead-metadata-that-breaks-prompt-caching`,
 * second-level timestamps in long-lived prompts thrash provider prompt
 * cache. Anthropic prompt cache keys by prefix; we therefore:
 *
 *   - quantize precision to MINUTE (truncate seconds) so the injected
 *     line stays stable within a 60-second window — cache hit rate
 *     for a 60s-spaced burst of agent_start events stays >0
 *   - append to the END of the system prompt — anything cached BEFORE
 *     the injection is unaffected even when the injection changes
 *   - do NOT prepend or splice into the cached prefix
 *
 * ## Sub-agent visibility
 *
 * Unlike abrain/rule-injector, this extension intentionally does NOT
 * call `isSubAgentSession(ctx)` to skip. The reason:
 *
 *   - rule-injector injects project-specific *framing* that could
 *     shadow the parent's explicit dispatch task brief
 *   - time-injector injects neutral *data* (the wall clock) that never
 *     conflicts with any task framing
 *
 * Sub-agents picking up the same time line is desirable: it lets
 * dispatch_agent prompts express "look for events in the last N hours"
 * without the caller having to manually format Date.now() into the prompt.
 *
 * ## Marker contract
 *
 * Every injection is wrapped in matching BEGIN/END HTML comments so
 * future audits (or this extension itself, if pi ever calls
 * before_agent_start twice within one turn) can detect and dedupe.
 * pi's current runner calls before_agent_start exactly once per turn
 * (see `core/extensions/runner.js:emitBeforeAgentStart`), so dedupe
 * is a safety net, not a hot path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hoistVolatileSuffix } from "../_shared/volatile-suffix";

const BEGIN_MARKER = "<!-- pi-astack/time-injector: minute-precision wall clock -->";
const END_MARKER = "<!-- /pi-astack/time-injector -->";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Two-digit zero-pad. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format the local-time line. Precision is minute; we explicitly DO NOT
 * include seconds (see "Precision = minute" in the file header).
 *
 * Output shape:
 *   Current date and time: 2026-05-28 10:31 +0800 (Asia/Shanghai, Thursday)
 *
 * Components are chosen so the line is human-readable AND machine-
 * parseable in two passes (ISO-ish date + offset, plus IANA zone +
 * weekday hint in parens).
 */
export function formatTimeLine(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());

  // tz offset: getTimezoneOffset returns minutes WEST of UTC (i.e., the
  // sign is opposite to ISO 8601 convention). Asia/Shanghai → -480 → +0800.
  const offsetWestMin = now.getTimezoneOffset();
  const offsetEastMin = -offsetWestMin;
  const sign = offsetEastMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetEastMin);
  const offHH = pad2(Math.floor(absMin / 60));
  const offMM = pad2(absMin % 60);
  const offset = `${sign}${offHH}${offMM}`;

  // IANA zone identifier (best-effort; never throws because
  // Intl.DateTimeFormat is part of the ECMA-402 baseline node ships).
  let tz: string;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    tz = "local";
  }

  const weekday = WEEKDAYS[now.getDay()] ?? "Unknown";

  return `Current date and time: ${y}-${mo}-${d} ${h}:${mi} ${offset} (${tz}, ${weekday})`;
}

/**
 * Wrap the line in BEGIN/END markers and an explanatory comment.
 * Returns the full block to splice into the system prompt tail.
 */
export function composeBlock(line: string): string {
  return `${BEGIN_MARKER}\n${line}\n${END_MARKER}`;
}

/**
 * Strip a previous time-injector block from a system prompt, if any.
 * Defensive: removes one or many occurrences. Used to keep the prompt
 * idempotent if pi ever calls before_agent_start more than once per
 * turn or stacks two injectors by mistake.
 */
export function stripExistingBlock(prompt: string): string {
  // Greedy strip: BEGIN_MARKER ... END_MARKER plus the surrounding
  // newlines we added on injection.
  const re = new RegExp(
    `(?:\\n*)${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}(?:\\n*)`,
    "g",
  );
  return prompt.replace(re, "\n\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_TIME_INJECTOR === "1") return;

  pi.on("before_agent_start", async (event /*, ctx */) => {
    const current = event.systemPrompt ?? "";

    // Defensive dedupe in case a previous handler or a re-emit left
    // a stale block in place (would carry an old minute).
    const cleaned = stripExistingBlock(current);

    // Hoist every volatile-wrapped block (goal status, path-A memory recall)
    // to the end so the session-stable prefix stays byte-identical across
    // turns. time-injector is the effective last injector, so it finalizes the
    // prefix-cache partition; the time block is appended strictly after the
    // hoisted volatile tail.
    const hoisted = hoistVolatileSuffix(cleaned);

    const line = formatTimeLine();
    const block = composeBlock(line);

    // Append at the very END of the system prompt. Anthropic prompt
    // cache keys by prefix; anything cached before this point keeps
    // its cache validity across minutes.
    const next = `${hoisted.replace(/\n+$/, "")}\n\n${block}\n`;

    return { systemPrompt: next };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Test-only exports (kept stable for scripts/smoke-time-injector.mjs)
// ──────────────────────────────────────────────────────────────────────

export const __TEST = {
  BEGIN_MARKER,
  END_MARKER,
  formatTimeLine,
  composeBlock,
  stripExistingBlock,
};
